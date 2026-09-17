import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import MagicMock, patch

spec = importlib.util.spec_from_file_location("notify_issue", Path(__file__).resolve().parents[1] / "Scripts/notify-issue.py")
notify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(notify)


class IssueNotificationTests(unittest.TestCase):
    def event(self, action="opened", actor="contributor"):
        return {"action": action, "issue": {"number": 12, "title": '中文 " $(touch /tmp/never)\nsecond line', "user": {"login": actor}},
                "comment": {"user": {"login": actor}}}

    def test_issue_text_is_data_and_link_is_repository_owned(self):
        event = self.event()
        event["issue"]["html_url"] = "https://untrusted.invalid"
        result = notify.notification("issues", event, "yatotm")
        self.assertEqual(result["body"], event["issue"]["title"])
        self.assertEqual(result["url"], "https://github.com/yatotm/CodexBar/issues/12")

    def test_self_events_and_pull_request_comments_are_ignored(self):
        self.assertIsNone(notify.notification("issues", self.event(actor="YatoTm"), "yatotm"))
        self.assertIsNone(notify.notification("issue_comment", self.event("created", "YATOTM"), "yatotm"))
        event = self.event("created")
        event["issue"]["pull_request"] = {"url": "https://github.com/yatotm/CodexBar/pull/12"}
        self.assertIsNone(notify.notification("issue_comment", event, "yatotm"))

    def test_unsupported_events_and_actions_do_not_send(self):
        self.assertIsNone(notify.notification("push", self.event(), "yatotm"))
        self.assertIsNone(notify.notification("issues", self.event("edited"), "yatotm"))

    def test_manual_test_has_no_issue_dependency(self):
        self.assertEqual(notify.notification("workflow_dispatch", {}, "yatotm")["body"], "Bark 配置有效")

    def test_endpoint_requires_https_and_no_embedded_credentials(self):
        self.assertEqual(notify.endpoint("https://bark.example/path/"), "https://bark.example/path/push")
        for value in ["http://bark.example", "https://user:key@bark.example", "https://bark.example?key=x", "https://bark.example#x", "file:///tmp/test"]:
            with self.assertRaises(ValueError):
                notify.endpoint(value)
        self.assertIsNone(notify.NoRedirect().redirect_request(None, None, 302, "redirect", {}, "https://other.invalid"))

    def test_secrets_only_enter_post_body_and_never_logs(self):
        with tempfile.TemporaryDirectory() as directory:
            event_path = Path(directory) / "event.json"
            event_path.write_text(json.dumps(self.event()))
            env = {"GITHUB_REPOSITORY": "yatotm/CodexBar", "GITHUB_EVENT_PATH": str(event_path), "GITHUB_EVENT_NAME": "issues",
                   "BARK_TOKEN": "private-device-key", "BARK_SERVER_URL": "https://bark.example"}
            opener = MagicMock()
            opener.open.return_value.__enter__.return_value.read.return_value = b'{"code":200}'
            output = io.StringIO()
            with patch.object(notify.urllib.request, "build_opener", return_value=opener), contextlib.redirect_stdout(output):
                notify.main(env)
            request = opener.open.call_args.args[0]
            self.assertEqual(request.method, "POST")
            self.assertEqual(request.full_url, "https://bark.example/push")
            self.assertEqual(json.loads(request.data)["device_key"], "private-device-key")
            self.assertNotIn("private-device-key", output.getvalue())

    def test_missing_configuration_and_other_forks_never_contact_server(self):
        with tempfile.TemporaryDirectory() as directory:
            event_path = Path(directory) / "event.json"
            event_path.write_text(json.dumps(self.event()))
            env = {"GITHUB_REPOSITORY": "yatotm/CodexBar", "GITHUB_EVENT_PATH": str(event_path), "GITHUB_EVENT_NAME": "issues"}
            with patch.object(notify.urllib.request, "build_opener") as opener, contextlib.redirect_stdout(io.StringIO()):
                notify.main(env)
                notify.main({"GITHUB_REPOSITORY": "another/fork"})
            opener.assert_not_called()


if __name__ == "__main__":
    unittest.main()
