#!/usr/bin/env python3
"""Report partial publication without hiding either matrix job failure."""
import json
import os
from pathlib import Path


def summarize(candidate, results):
    channels = {}
    for item in results:
        if any(item.get(key) != candidate.get(key) for key in ('version', 'commit', 'digest')):
            raise RuntimeError('Published channel identity mismatch')
        channel = item.get('channel')
        if channel not in ('acr', 'ghcr') or channel in channels:
            raise RuntimeError('Invalid publication result channel')
        channels[channel] = item
    return channels


def main():
    directory = Path('build/candidate')
    candidate = json.loads((directory / 'image.json').read_text())
    channels = summarize(candidate, [json.loads(p.read_text()) for p in Path('build/published').glob('*/image.json')])
    with open(os.environ.get('GITHUB_STEP_SUMMARY', os.devnull), 'a') as stream:
        stream.write('## Registry publication\n\n')
        for channel in ('acr', 'ghcr'):
            stream.write(f'- {channel}: {"success" if channel in channels else "failed or incomplete"}\n')
        stream.write('\nAny failed channel keeps the overall workflow red; successful images remain usable.\n')
    if not channels:
        raise RuntimeError('Both registry publications failed; no GitHub Release will be published')
    (directory / 'image.json').write_text(json.dumps(next(iter(channels.values())), indent=2) + '\n')


if __name__ == '__main__':
    main()
