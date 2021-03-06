/**
 * Copyright (c) 2017-present PlatformIO <contact@platformio.org>
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */

import { getCacheDir, getCoreDir, getEnvBinDir, getEnvDir } from './core';

import fs from 'fs';
import fsPlus from 'fs-plus';
import os from 'os';
import path from 'path';
import qs from 'querystringify';
import request from 'request';
import spawn from 'cross-spawn';
import tmp from 'tmp';

const CHECK_PYTHON_SCRIPT = `
import os
import sys


IS_WINDOWS = sys.platform.lower().startswith("win")
PYTHON_EXE = sys.executable
CHECK_HTTPS_URLS = ["https://github.com", "https://platformio.org"]


def check_min_version():
    assert (
        sys.version_info >= (2, 7, 9) and sys.version_info < (3,)
    ) or sys.version_info >= (3, 5)


def check_win_custom():
    assert not any(s in PYTHON_EXE.lower() for s in ("msys", "mingw", "emacs"))
    assert os.path.isdir(os.path.join(sys.prefix, "Scripts")) or (
        sys.version_info >= (3, 5) and __import__("venv")
    )


def check_urllib_ssl():
    for url in CHECK_HTTPS_URLS:
        if url_status_ok(url):
            return True
    return False


def url_status_ok(url):
    for f in (
        urllib_url_status_ok,
        urllib3_url_status_ok,
        requests_url_status_ok,
    ):
        try:
            assert f(url)
            return True
        except Exception as e:
            print(e)
    return False


def urllib_url_status_ok(url):
    try:
        from urllib.request import urlopen
    except ImportError:
        from urllib import urlopen
    try:
        return int(urlopen(url).getcode()) == 200
    except:
        return False


def urllib3_url_status_ok(url):
    import urllib3

    try:
        return int(urllib3.PoolManager().request("GET", url).status) == 200
    except:
        return False


def requests_url_status_ok(url):
    import requests

    r = requests.get(url)
    r.raise_for_status()
    return True


if __name__ == "__main__":
    # we do not support cygwin
    assert sys.platform != "cygwin"

    check_min_version()

    if IS_WINDOWS:
        check_win_custom()

    assert check_urllib_ssl()

    print(PYTHON_EXE)
    sys.exit(0)

`;

export const IS_WINDOWS = process.platform.startsWith('win');

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function patchOSEnviron({
  caller,
  useBuiltinPIOCore = true,
  extraPath,
  extraVars
}) {
  process.env.PLATFORMIO_CALLER = caller;
  // Fix for platformio-atom-ide/issues/112
  if (process.platform === 'darwin') {
    process.env.LC_ALL = 'en_US.UTF-8';
  }
  if (caller === 'atom') {
    process.env.PLATFORMIO_DISABLE_PROGRESSBAR = 'true';
  }

  if (extraVars) {
    Object.keys(extraVars).forEach(name => (process.env[name] = extraVars[name]));
  }

  // Fix for https://github.com/atom/atom/issues/11302
  if (process.env.Path) {
    if (process.env.PATH) {
      process.env.PATH += path.delimiter + process.env.Path;
    } else {
      process.env.PATH = process.env.Path;
    }
  }

  if (useBuiltinPIOCore) {
    // Insert bin directory into PATH
    process.env.PATH = [getEnvBinDir(), getEnvDir(), process.env.PATH].join(
      path.delimiter
    );
  } else {
    // Remove bin directory from PATH
    process.env.PATH = process.env.PATH.split(path.delimiter)
      .filter(p => !p.includes(getEnvDir()))
      .join(path.delimiter);
  }

  if (extraPath && !process.env.PATH.includes(extraPath)) {
    process.env.PATH = [extraPath, process.env.PATH].join(path.delimiter);
  }

  // Expand Windows environment variables in %xxx% format
  const reWindowsEnvVar = /\%([^\%]+)\%/g;
  while (IS_WINDOWS && reWindowsEnvVar.test(process.env.PATH)) {
    process.env.PATH = process.env.PATH.replace(reWindowsEnvVar, (_, envvar) => {
      return process.env[envvar] || '';
    });
  }

  // copy PATH to Path (Windows issue)
  if (process.env.Path) {
    process.env.Path = process.env.PATH;
  }

  // Configure NO_PROXY for PIO Home
  process.env.NO_PROXY =
    '127.0.0.1' + (process.env.NO_PROXY ? `,${process.env.NO_PROXY}` : '');
}

export function runCommand(cmd, args, callback = undefined, options = {}) {
  console.info('runCommand', cmd, args, options);
  const outputLines = [];
  const errorLines = [];
  let completed = false;
  let tmpDir = null;

  options.spawnOptions = options.spawnOptions || {};
  if (!options.spawnOptions.cwd && fsPlus.isDirectorySync(getEnvBinDir())) {
    options.spawnOptions.cwd = getEnvBinDir();
  }

  if (
    IS_WINDOWS &&
    ['pip', 'virtualenv'].some(item => [path.basename(cmd), ...args].includes(item))
  ) {
    // Overwrite TMPDIR and avoid issue with ASCII error for Python's PIP
    const tmpEnv = Object.assign({}, process.env);
    tmpDir = tmp.dirSync({
      dir: getCacheDir(),
      unsafeCleanup: true
    }).name;
    tmpEnv.TMPDIR = tmpEnv.TEMP = tmpEnv.TMP = tmpDir;
    options.spawnOptions.env = tmpEnv;
    options.spawnOptions.cwd = tmpDir;
  }

  try {
    const child = spawn(cmd, args, options.spawnOptions);

    child.stdout.on('data', line => outputLines.push(line));
    child.stderr.on('data', line => errorLines.push(line));
    child.on('close', onExit);
    child.on('error', err => {
      errorLines.push(err.toString());
      onExit(-1);
    });
  } catch (err) {
    errorLines.push(err.toString());
    onExit(-1);
  }

  function onExit(code) {
    if (completed || !callback) {
      return;
    }
    completed = true;

    if (tmpDir) {
      try {
        fsPlus.removeSync(tmpDir);
      } catch (err) {
        console.warn(err);
      }
    }

    const stdout = outputLines.map(x => x.toString()).join('');
    const stderr = errorLines.map(x => x.toString()).join('');
    callback(code, stdout, stderr);
  }
}

export function processHTTPRequest(url, callback, options) {
  options = options || {};
  options.url = url;
  if (!options.headers) {
    options.headers = {
      'User-Agent': 'PlatformIO'
    };
  }
  console.info('processHTTPRequest', options);
  return request(options, (err, response, body) => {
    return callback(err, response, body);
  });
}

export async function getPythonExecutable(
  useBuiltinPIOCore = true,
  customDirs = undefined
) {
  const exenames = IS_WINDOWS ? ['python.exe'] : ['python3', 'python', 'python2'];
  const locations = customDirs || [];

  if (useBuiltinPIOCore) {
    locations.push(getEnvBinDir());
    locations.push(getEnvDir()); // conda
  }
  if (IS_WINDOWS) {
    // isolated Python 3.7 in PlatformIO Home directory
    locations.push(path.join(getCoreDir(), 'python37'));
  }
  // extend with paths from env.PATH
  process.env.PATH.split(path.delimiter).forEach(item => {
    if (!locations.includes(item)) {
      locations.push(item);
    }
  });

  const checkScriptPath = path.join(getCacheDir(), 'check-python.py');
  fs.writeFile(checkScriptPath, CHECK_PYTHON_SCRIPT, err => {
    if (err) {
      console.error(err);
    }
  });

  for (const location of locations) {
    for (const exename of exenames) {
      const executable = path.normalize(path.join(location, exename)).replace(/"/g, '');
      if (
        fs.existsSync(executable) &&
        (await _isCompatiblePython(executable, checkScriptPath))
      ) {
        return executable;
      }
    }
  }
  return undefined;
}

function _isCompatiblePython(executable, checkScriptPath) {
  return new Promise(resolve => {
    runCommand(executable, [checkScriptPath], (code, stdout, stderr) => {
      console.info(stdout);
      if (stderr) {
        console.warn(stderr);
      }
      resolve(code === 0);
    });
  });
}

export function getErrorReportUrl(title, description) {
  const errorToUrls = [
    [
      'System: Darwin, 19.0.0',
      'https://github.com/platformio/platformio-vscode-ide/issues/1108'
    ],
    [
      'WindowsError: [Error 5]',
      'https://github.com/platformio/platformio-vscode-ide/issues/884'
    ],
    [
      'Could not start PIO Home server: Error: timeout',
      'https://github.com/platformio/platformio-vscode-ide/issues/205'
    ],
    [
      'Failed to download file',
      'https://github.com/platformio/platformio-vscode-ide/issues/386'
    ],
    [
      'Conda Virtualenv',
      'https://github.com/platformio/platformio-vscode-ide/issues/914'
    ],
    [
      "ModuleNotFoundError: No module named 'distutils",
      'https://github.com/platformio/platformio-vscode-ide/issues/907'
    ]
  ];
  for (const item of errorToUrls) {
    if (description.includes(item[0])) {
      return item[1];
    }
  }
  return `https://github.com/platformio/platformio-${process.env.PLATFORMIO_CALLER ||
    'vscode'}-ide/issues/new?${qs.stringify({
    title,
    body: description,
    labels: 'auto'
  })}`;
}

export function isPIOProject(dir) {
  return fsPlus.isFileSync(path.join(dir, 'platformio.ini'));
}

export function arrayRemove(array, element) {
  return array.splice(array.indexOf(element), 1);
}

export function disposeSubscriptions(subscriptions) {
  while (subscriptions.length) {
    subscriptions.pop().dispose();
  }
}

function uuid() {
  const s4 = () =>
    Math.floor((1 + Math.random()) * 0x10000)
      .toString(16)
      .substring(1);
  return `${s4()}${s4()}-${s4()}-${s4()}-${s4()}-${s4()}${s4()}${s4()}`;
}

export function reportError(err) {
  const data = {
    v: 1,
    tid: 'UA-1768265-13',
    cid: uuid(),
    aid: 'node.helpers',
    av: PACKAGE_VERSION,
    an: `${os.type()}, ${os.release()}, ${os.arch()}`,
    t: 'exception',
    exd: err.toString(),
    exf: 1
  };
  if (process.env.PLATFORMIO_CALLER) {
    data['cd1'] = process.env.PLATFORMIO_CALLER;
  }
  request.post('https://www.google-analytics.com/collect', {
    body: qs.stringify(data)
  });
}
