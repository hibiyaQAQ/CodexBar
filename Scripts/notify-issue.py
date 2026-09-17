#!/usr/bin/env python3
"""仓库 Issue 的 Bark 通知, 不执行事件文本, 不输出设备密钥"""

import json
import os
from pathlib import Path
import sys
import urllib.error
import urllib.parse
import urllib.request

REPOSITORY = "yatotm/CodexBar"


def notification(event_name, event, self_login):
    if event_name == "workflow_dispatch":
        return {"title": "CodexBar Issues 通知测试", "body": "Bark 配置有效",
                "url": f"https://github.com/{REPOSITORY}/issues"}
    issue = event.get("issue", {})
    if issue.get("pull_request"):
        return None
    if event_name == "issues" and event.get("action") == "opened":
        title = "CodexBar 有新的 Issue"
        actor = issue.get("user", {}).get("login", "")
    elif event_name == "issue_comment" and event.get("action") == "created":
        title = "CodexBar Issue 有新的评论"
        actor = event.get("comment", {}).get("user", {}).get("login", "")
    else:
        return None
    if actor.casefold() == self_login.casefold():
        return None
    number = issue.get("number")
    if type(number) is not int or number <= 0:
        raise ValueError("Issue 编号无效")
    return {"title": title, "body": str(issue.get("title", ""))[:500],
            "url": f"https://github.com/{REPOSITORY}/issues/{number}"}


def endpoint(server):
    parsed = urllib.parse.urlsplit(server.rstrip("/"))
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("BARK_SERVER_URL 需要不含凭据和查询参数的 HTTPS 地址")
    return server.rstrip("/") + "/push"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # 设备密钥只发送到显式配置的服务器
        return None


def main(env=os.environ):
    if env.get("GITHUB_REPOSITORY") != REPOSITORY:
        print("Skipped: repository does not match")
        return
    event = json.loads(Path(env["GITHUB_EVENT_PATH"]).read_text())
    message = notification(env.get("GITHUB_EVENT_NAME"), event, env.get("SELF_LOGIN") or REPOSITORY.split("/")[0])
    if message is None:
        print("Skipped: event does not need a notification")
        return
    token = env.get("BARK_TOKEN", "").strip()
    server = env.get("BARK_SERVER_URL", "").strip() or "https://api.day.app"
    if not token:
        print("Skipped: configure the BARK_TOKEN repository secret")
        return
    payload = {**message, "device_key": token, "group": "CodexBar Issues"}
    icon = env.get("BARK_ICON_URL", "").strip()
    if icon:
        if urllib.parse.urlsplit(icon).scheme != "https":
            raise ValueError("BARK_ICON_URL 需要 HTTPS 地址")
        payload["icon"] = icon
    request = urllib.request.Request(endpoint(server), data=json.dumps(payload, ensure_ascii=False).encode(),
                                     headers={"Content-Type": "application/json; charset=utf-8"}, method="POST")
    with urllib.request.build_opener(NoRedirect()).open(request, timeout=30) as response:
        result = json.loads(response.read(65536))
    if result.get("code") != 200:
        raise RuntimeError("Bark 未确认接收通知")
    print("Bark notification sent")


if __name__ == "__main__":
    try:
        main()
    except urllib.error.HTTPError as error:
        print(f"Bark HTTP error: {error.code}", file=sys.stderr)
        sys.exit(1)
    except Exception as error:
        print("Bark notification failed: " + type(error).__name__, file=sys.stderr)
        sys.exit(1)
