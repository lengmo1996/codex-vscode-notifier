import json
import os
from pathlib import Path
import subprocess
import sys
import time

launch_path = Path(sys.argv[1]).resolve()
launch = json.loads(launch_path.read_text(encoding='utf-8'))
runtime = Path(launch['runtime'])
environment = dict(os.environ)
environment.pop('ELECTRON_RUN_AS_NODE', None)
environment.update(launch['env'])
startup = subprocess.STARTUPINFO()
startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
startup.wShowWindow = 0
log_path = runtime / 'vscode-process.log'
with log_path.open('wb') as log:
    process = subprocess.Popen([launch['code'], *launch['args']], env=environment,
                               stdout=log, stderr=subprocess.STDOUT,
                               creationflags=subprocess.CREATE_NO_WINDOW, startupinfo=startup)
    print(json.dumps({'pid': process.pid, 'log': str(log_path), 'report': launch['env']['CODEX_NOTIFIER_TEST_REPORT']}), flush=True)
    try:
        result = process.wait(timeout=180)
    except subprocess.TimeoutExpired:
        process.terminate()
        print('Isolated VS Code test exceeded 180 seconds; stopped its main process.', flush=True)
        raise SystemExit(1)
report = Path(launch['env']['CODEX_NOTIFIER_TEST_REPORT'])
if report.exists():
    print(report.read_text(encoding='utf-8'), flush=True)
else:
    print('No extension-host report was written. Inspect ' + str(log_path), flush=True)
    print(log_path.read_text(encoding='utf-8', errors='replace')[-12000:], flush=True)
raise SystemExit(result)
