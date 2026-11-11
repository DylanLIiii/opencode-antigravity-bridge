# Provenance

`agy-patch.py` is an unmodified copy of `agy-context-unlock/agy-patch.py` from
<https://github.com/lili-luo/dsh-plugin-bundle> at commit
`0a90ec37c69430608084e33ebc2f891e328c9e89`.

- Copyright (c) 2026 lili-luo, MIT License (see `LICENSE` in this directory).
- SHA-256: `6c4edf9e4b86166abae4409d879faabe8f1e28a52d5c97d778b4e48bda46c413`
  (the bridge refuses to run the file if its hash differs).
- Upstream only claims end-to-end verification on agy 1.4.12 - 1.5.3. The bridge
  never edits the official agy install: `agy-bridge context unlock` patches a
  bridge-managed copy and re-checks every gate on that copy.
