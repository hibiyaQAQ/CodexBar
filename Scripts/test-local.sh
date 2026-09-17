#!/bin/bash
set -euo pipefail
test_root="$(cd "$(dirname "$0")/.." && pwd)"
python3 -B - "$test_root" <<'PYTHON'
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

root = Path(sys.argv[1])
output = Path(os.environ.get("CODEXBAR_TEST_OUTPUT", str(Path.home() / "Library/Caches/CodexBar/TestBuild")))
output.mkdir(parents=True, exist_ok=True)
os.environ.setdefault("LLVM_PROFILE_FILE", str(output / "coverage-%p.profraw"))
with tempfile.TemporaryDirectory(prefix="codexbar-test-project-", dir="/tmp") as directory:
    stage = Path(directory)
    shutil.copytree(root / "CodexBar.xcodeproj", stage / "CodexBar.xcodeproj")
    for name in ("CodexBar", "CodexBarTests", "CodexBarHelper", "Shared", "Config"):
        (stage / name).symlink_to(root / name)
    project = stage / "CodexBar.xcodeproj/project.pbxproj"
    project.write_text(project.read_text().replace("objectVersion = 100;", "objectVersion = 77;")
                       .replace("preferredProjectObjectVersion = 100;", "preferredProjectObjectVersion = 77;"))
    log_path = output / "test.log"
    with log_path.open("w") as log:
        result = subprocess.run([
            "xcodebuild", "-project", str(stage / "CodexBar.xcodeproj"), "-scheme", "CodexBar",
            "-destination", "platform=macOS", "-derivedDataPath", str(output / "DerivedData"),
            "-only-testing:CodexBarTests", "CODE_SIGNING_ALLOWED=NO", "CODE_SIGN_ENTITLEMENTS=",
            "ENABLE_DEBUG_DYLIB=NO", "test"
        ], stdout=log, stderr=subprocess.STDOUT)
    lines = log_path.read_text(errors="replace").splitlines()
    for line in lines:
        if "error:" in line or "failed" in line.lower() or "Test run with" in line or "** TEST" in line:
            print(line[:400])
    print("Test log: " + str(log_path))
    sys.exit(result.returncode)
PYTHON
