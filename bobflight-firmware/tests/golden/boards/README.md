<!-- SPDX-License-Identifier: Apache-2.0 -->
# Migration goldens (main 5bea523)

Frozen outputs of the pre-migration generators, used by
`tests/test_board_migration_equivalence.py`. Do not regenerate them from the new
board files; that would make the equivalence test trivially pass.

- `<board>.pins_generated.h`: `scripts/ir_codegen.py` at 5bea523 run on the old
  `boards/{holybro,matek,tmotor}-ir/*.yaml` and `boards/dummy.yaml` IR.
- `registry_list.json`: `scripts/target_registry.py list --json` at 5bea523
  (old `targets/boards/*.json`).
- `ir_load_main_5bea523.c`: `src/board/ir_load.c` at 5bea523, with the
  hand-written per-board UART tables now generated from `uarts:`.

Reproduce: `git show 5bea523:bobflight-firmware/<path>` for each input, then run
the 5bea523 scripts.
