"""SFTP-backed storage for capture photos and planogram files. Replaces
local disk (data/uploads/) so photos survive independently of the app VM.
One connection per operation, same one-connection-per-call convention as
_fab_conn() in app.py — this app has no sustained traffic that would make
connection pooling worth the complexity."""
import os
import paramiko

_SFTP_HOST = os.environ.get('SFTP_HOST', '')
_SFTP_PORT = int(os.environ.get('SFTP_PORT', 22))
_SFTP_USER = os.environ.get('SFTP_USER', '')
_SFTP_PASS = os.environ.get('SFTP_PASS', '')
_SFTP_ROOT = os.environ.get('SFTP_ROOT', 'money_mapping_uploads')


def _connect():
    transport = paramiko.Transport((_SFTP_HOST, _SFTP_PORT))
    transport.connect(username=_SFTP_USER, password=_SFTP_PASS)
    return transport, paramiko.SFTPClient.from_transport(transport)


def _ensure_dir(sftp, remote_dir: str):
    path = ''
    for part in remote_dir.split('/'):
        if not part:
            continue
        path = f'{path}/{part}' if path else part
        try:
            sftp.stat(path)
        except FileNotFoundError:
            sftp.mkdir(path)


def upload(data: bytes, rel_path: str):
    """rel_path is a forward-slash path relative to _SFTP_ROOT, e.g.
    'money_mapping/2554/<uuid>.jpg'."""
    transport, sftp = _connect()
    try:
        parts = rel_path.split('/')
        _ensure_dir(sftp, '/'.join([_SFTP_ROOT] + parts[:-1]))
        with sftp.open(f'{_SFTP_ROOT}/{rel_path}', 'wb') as f:
            f.write(data)
    finally:
        sftp.close()
        transport.close()


def download(rel_path: str) -> bytes:
    """Raises FileNotFoundError if the file doesn't exist remotely."""
    transport, sftp = _connect()
    try:
        with sftp.open(f'{_SFTP_ROOT}/{rel_path}', 'rb') as f:
            return f.read()
    finally:
        sftp.close()
        transport.close()


def delete(rel_path: str):
    """Best-effort — silently OK if the file is already gone."""
    transport, sftp = _connect()
    try:
        try:
            sftp.remove(f'{_SFTP_ROOT}/{rel_path}')
        except FileNotFoundError:
            pass
    finally:
        sftp.close()
        transport.close()
