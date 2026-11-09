"""Download official FP32 Open Model Zoo weights; verify publisher SHA-384."""
import hashlib
from pathlib import Path
from urllib.request import urlopen

FILES = {
 'face-detection-retail-0004.xml': '1933e7a49baafaf809c4d4c89d6380f018cccdd3be9f96360bc5de3f3008412fbb262236e06fddb3ecdbb5a6a990d010',
 'face-detection-retail-0004.bin': 'a2b4fa6dc07a37fb70d3ff11c207e19c167d45b6db5392e7e759b924df8ce16dbcdb8edff682c38820cc2e54bf6fdabf',
 'age-gender-recognition-retail-0013.xml': 'ab3efa2de0566ceba6e1b3c55774ad9e93e71f9be81506df90d4e7a8055aa98673211af6ef91d848d78849c0cdcb72bc',
 'age-gender-recognition-retail-0013.bin': 'a84d760d1d287b7105879c5e93cf5ebd6cbbd34fa809068b118c6adefc62448fefd8d06322dd2266f5ed98b8dd3901fc',
}

def download():
    dest = Path(__file__).parent / 'models'
    dest.mkdir(exist_ok=True)
    for name, expected in FILES.items():
        path = dest / name
        if path.exists() and hashlib.sha384(path.read_bytes()).hexdigest() == expected:
            continue
        url = 'https://storage.openvinotoolkit.org/repositories/open_model_zoo/2023.0/models_bin/1/' + name.rsplit('.', 1)[0] + '/FP32/' + name
        with urlopen(url, timeout=120) as response:
            data = response.read(12_000_000)
        if hashlib.sha384(data).hexdigest() != expected:
            raise RuntimeError('Model checksum mismatch: ' + name)
        path.write_bytes(data)
    with urlopen('https://raw.githubusercontent.com/openvinotoolkit/open_model_zoo/master/LICENSE', timeout=30) as response:
        (dest / 'LICENSE').write_bytes(response.read(100000))

if __name__ == '__main__':
    download()
