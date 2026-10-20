#!/usr/bin/env python3
"""Built-in-only supervisor for Python images; no Node dependency."""
import http.client
import json
import os
from pathlib import Path
import shlex
import signal
import socket
import subprocess
import sys
import time
from urllib.parse import urlsplit

control = Path(sys.argv[1] if len(sys.argv) > 1 else '/freshclone')
workspace = Path(sys.argv[2] if len(sys.argv) > 2 else '/workspace').resolve()
temporary = Path(sys.argv[3] if len(sys.argv) > 3 else '/tmp')
plan = json.loads((control / 'plan.json').read_text())
config, blocks = plan['config'], plan['blocks']
started = time.monotonic()
report = dict(schemaVersion=1, ok=False, image=config['image'], readme=plan['readme'],
              steps=[dict(block=b['id'], line=b['line'], status='skipped', output='', durationMs=0) for b in blocks],
              assertions=[], durationMs=0)
if config.get('scenario'):
    report['scenario'] = config['scenario']
child = None
active = -1
step_started = 0
wrapper = None


def progress(message):
    print('FRESHCLONE_EVENT ' + json.dumps(dict(message=message)), file=sys.stderr, flush=True)


def output(index):
    try:
        with (temporary / f'freshclone-step-{index}.log').open('rb') as log:
            log.seek(0, 2)
            size = log.tell()
            log.seek(max(0, size - 65536))
            return log.read(65536).decode('utf-8', errors='replace')
    except OSError:
        return ''


def finish(ok, error=None, kind=None):
    report['ok'] = ok
    if error:
        report['error'] = error
    if kind:
        report['failureKind'] = kind
    if active >= 0 and report['steps'][active]['status'] != 'passed':
        report['steps'][active]['status'] = 'failed'
        report['steps'][active]['durationMs'] = round((time.monotonic() - step_started) * 1000)
    if child:
        try:
            os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    for index, step in enumerate(report['steps']):
        step['output'] = output(index)
    report['durationMs'] = round((time.monotonic() - started) * 1000)
    print(json.dumps(report), flush=True)
    raise SystemExit(0 if ok else 1)


def assertions():
    expected = config.get('expect', {})
    for file in expected.get('files', []):
        resolved = (workspace / file).resolve()
        ok = resolved.is_relative_to(workspace) and resolved.is_file()
        report['assertions'].append(dict(name='file: ' + file, ok=ok))
    for entry in expected.get('output', []):
        index = next(i for i, block in enumerate(blocks) if block['id'] == entry['block'])
        report['assertions'].append(dict(name='output: ' + entry['block'], ok=entry['contains'] in output(index)))
    failed = [entry['name'] for entry in report['assertions'] if not entry['ok']]
    finish(not failed, 'Expectations failed: ' + ', '.join(failed) + '.' if failed else None, 'expectation' if failed else None)


def equal(left, right):
    # JSON numbers compare numerically, but booleans must not equal 0 or 1.
    if isinstance(left, bool) or isinstance(right, bool):
        return type(left) is type(right) and left == right
    if isinstance(left, dict) and isinstance(right, dict):
        return left.keys() == right.keys() and all(equal(left[key], right[key]) for key in left)
    if isinstance(left, list) and isinstance(right, list):
        return len(left) == len(right) and all(equal(a, b) for a, b in zip(left, right))
    return left == right


def readiness():
    expected = config['expect']['http']
    target = urlsplit(expected['url'])
    until = time.monotonic() + expected['timeout']
    report['http'] = dict(url=expected['url'], ok=False)
    progress('Waiting for ' + expected['url'])
    while time.monotonic() < until:
        if child.poll() is not None:
            report['steps'][active]['exitCode'] = child.returncode
            finish(False, f'Application exited before readiness (exit {child.returncode}).', 'application-exit')
        connection = http.client.HTTPConnection('127.0.0.1', target.port or 80, timeout=min(1, max(.001, until - time.monotonic())))
        try:
            connection.request('GET', (target.path or '/') + ('?' + target.query if target.query else ''), headers={'Host': target.netloc})
            response = connection.getresponse()
            report['http']['status'] = response.status
            # Bound both response bytes and total request time, including slow bodies.
            data = bytearray()
            deadline = min(until, time.monotonic() + 1)
            while len(data) <= 1024 * 1024:
                if time.monotonic() >= deadline:
                    raise TimeoutError('Response body timeout')
                if connection.sock:
                    connection.sock.settimeout(max(.001, deadline - time.monotonic()))
                chunk = response.read1(min(65536, 1024 * 1024 + 1 - len(data)))
                if not chunk:
                    break
                data.extend(chunk)
            body = data.decode('utf-8', errors='replace')
            matches = len(data) <= 1024 * 1024 and response.status == expected['status']
            if 'contains' in expected:
                matches = matches and expected['contains'] in body
            if matches and 'json' in expected:
                parsed = json.loads(body)
                for field, value in expected['json'].items():
                    actual = parsed
                    for part in field.split('.'):
                        if isinstance(actual, list) and part.isdigit():
                            actual = actual[int(part)]
                        elif isinstance(actual, dict):
                            actual = actual[part]
                        else:
                            raise KeyError(part)
                    matches = matches and equal(actual, value)
            if matches:
                report['http']['ok'] = True
                report['steps'][active]['status'] = 'passed'
                report['steps'][active]['durationMs'] = round((time.monotonic() - step_started) * 1000)
                assertions()
        except (OSError, ValueError, KeyError, IndexError, http.client.HTTPException):
            pass
        finally:
            connection.close()
        time.sleep(.2)
    finish(False, f"Application did not satisfy HTTP {expected['status']} and configured response expectations within {expected['timeout']}s.", 'readiness-timeout')


def interrupt(_signum, _frame):
    finish(False, 'Check interrupted.', 'interrupted')


signal.signal(signal.SIGTERM, interrupt)
signal.signal(signal.SIGINT, interrupt)
try:
    for name, service in config.get('services', {}).items():
        progress(f"Waiting for service {name}:{service['port']}")
        until = time.monotonic() + service['timeout']
        while True:
            try:
                with socket.create_connection((name, service['port']), timeout=min(1, max(.001, until - time.monotonic()))):
                    break
            except OSError:
                if time.monotonic() >= until:
                    finish(False, f"Service {name}:{service['port']} was not ready within {service['timeout']}s.", 'service-readiness')
                time.sleep(.2)
    events_path = temporary / 'freshclone-events.jsonl'
    events_path.write_text('')
    script = ['set -e', 'umask 022']
    def event(kind, index):
        return 'printf \'%s\\n\' ' + shlex.quote(json.dumps(dict(event=kind, index=index))) + ' >> ' + shlex.quote(str(events_path))
    for index, step in enumerate(config['steps']):
        script.append(event('start', index))
        command = '. ' + shlex.quote(str(control / f'step-{index}.sh')) + ' > ' + shlex.quote(str(temporary / f'freshclone-step-{index}.log')) + ' 2>&1'
        if step.get('background'):
            script.extend([command + ' &', 'freshclone_service_pid=$!', event('background', index), 'wait "$freshclone_service_pid"'])
        else:
            script.extend([command, event('passed', index)])
    script_path = temporary / 'freshclone-run.sh'
    script_path.write_text('\n'.join(script) + '\n')
    wrapper = (temporary / 'freshclone-wrapper.log').open('w+b')
    child = subprocess.Popen([config.get('shell', 'sh'), str(script_path)], cwd=workspace,
                             env={**os.environ, **config.get('env', {})}, stdin=subprocess.DEVNULL,
                             stdout=wrapper, stderr=wrapper, start_new_session=True)
    with events_path.open() as events:
        while True:
            while True:
                position = events.tell()
                line = events.readline()
                if not line or not line.endswith('\n'):
                    events.seek(position)
                    break
                entry = json.loads(line)
                index = entry['index']
                if entry['event'] == 'start':
                    active = index
                    step_started = time.monotonic()
                    report['steps'][active]['status'] = 'failed'
                    progress(f"Running {blocks[active]['id']} ({plan['readme']}:{blocks[active]['line']})")
                elif entry['event'] == 'passed':
                    report['steps'][index].update(status='passed', exitCode=0, durationMs=round((time.monotonic() - step_started) * 1000))
                elif entry['event'] == 'background':
                    readiness()
            code = child.poll()
            if code is not None:
                # Read events once more after process exit to avoid losing the last marker.
                if events.read(1):
                    events.seek(events.tell() - 1)
                    continue
                background = config['steps'][-1].get('background')
                if code == 0 and not background and all(step['status'] == 'passed' for step in report['steps']):
                    assertions()
                if active >= 0:
                    report['steps'][active]['exitCode'] = code
                wrapper.flush()
                wrapper.seek(0, 2)
                wrapper.seek(max(0, wrapper.tell() - 65536))
                detail = wrapper.read(65536).decode('utf-8', errors='replace')
                finish(False, f'Step exited before onboarding completed (exit {code}). {detail}'.strip(), 'application-exit' if background and active == len(blocks) - 1 else 'setup')
            if active >= 0 and report['steps'][active]['status'] != 'passed' and time.monotonic() - step_started >= config['timeout']:
                finish(False, f"Step \"{blocks[active]['id']}\" exceeded {config['timeout']}s.", 'setup')
            time.sleep(.02)
except Exception as error:
    finish(False, str(error), 'infrastructure')
finally:
    if wrapper:
        wrapper.close()
