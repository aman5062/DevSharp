---
description: "Whether DevSharp is active, what it detected, when the next card is due"
disable-model-invocation: true
---
DevSharp handles this command locally in its UserPromptSubmit hook, so this text is normally never sent to Claude. If you (Claude) are reading this, the DevSharp hook is not running. Reply with exactly one line and nothing else: "DevSharp hook is not active — run `devsharp doctor` in a terminal." Do not use any tools.
