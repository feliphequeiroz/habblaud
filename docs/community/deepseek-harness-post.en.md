# Community posts — DeepSeek Harness in Habblaud

Ready-to-paste drafts. Replace the guide/patch links and attach the screenshots. Tone: excited, but honest about the
experimental status.

## Suggested images

1. `docs/community/habblaud-dsh.png` — overview with the DSH character.
2. `docs/community/habblaud-dsh-usage.png` — token card.
3. `docs/community/habblaud-dsh-terminal.png` — terminal + working message box.

## X / Twitter — thread

**1/6**
You run Claude Code and Codex in Habblaud… but what about DeepSeek Harness?

DSH now lives in the office too: its own badge, a terminal with the conversation, and messages sent straight from
Habblaud. 🧵

**2/6**
DSH stores sessions as zstd JSONL and has no hook like Codex. So I built a bridge:

session .zstd → events → `POST /api/dsh/events` → Habblaud.

It finds open sessions through `session.lock` and replays everything when Habblaud restarts.

**3/6**
The account card shows **tokens** (session, 5 h, week). DeepSeek bills per token, so faking Claude Code's percentage
windows would be wrong.

**4/6**
The terminal shows prompts, commands and results. The message box actually works: a Cordis plugin inside DSH polls
`/api/mod/inbox` and delivers via `sessionController.prompt`.

**5/6**
Everything is local:
• bridge and plugin only talk to 127.0.0.1
• no credentials leave the machine
• Habblaud World does not accept DSH yet (its protocol only knows Claude/Codex)

**6/6**
This is a local patch, not upstream. Full guide + patch:

👉 [GUIDE LINK]

If you try it, tell me what breaks. That is how the community gets better. 🐧

## LinkedIn

**DeepSeek Harness now lives in Habblaud too.**

If you follow Habblaud, you know it turns Claude Code and Codex sessions into a pixel-art office: characters, live
activity, approvals and usage.

Now DeepSeek Harness (DSH) joins as a first-class agent:
• its own badge and project room;
• live activity (prompt, tool, result, end of turn);
• token card (session, 5 h, week);
• a terminal with the conversation;
• messages sent from Habblaud directly into the DSH session.

The interesting engineering bit: DSH writes zstd-compressed JSONL and has no hook like Codex. A bridge reads open
sessions, translates events and feeds Habblaud's API. For messages, a Cordis plugin inside DSH polls the inbox and
injects the prompt into the session.

Everything local, no credentials leaving the machine.

Experimental, not upstream — full guide here: [GUIDE LINK]

#DeepSeek #AI #DeveloperTools #OpenSource #Habblaud #Agents

## Reddit / Discord (r/selfhosted, r/LocalLLaMA, Habblaud Discord)

**Title:** DeepSeek Harness in Habblaud: character, terminal and messages from the office

I use Habblaud to watch Claude Code and Codex, but DeepSeek Harness was left out. I built a local integration and I am
sharing the guide.

What works:
- every open DSH session becomes a character with a DSH badge;
- live activity and a token card (session, 5 h, week);
- terminal with the conversation (prompts, tools, results);
- Habblaud's message box delivering prompts through a Cordis plugin.

How:
- a TypeScript bridge reads `~/.dsh/sessions/**/session.v4.jsonl.zstd`, finds open sessions via `session.lock`, and
  posts to `POST /api/dsh/events`;
- a plugin in the DSH profile (`~/.dsh/profiles/desktop/cordis.patch.yml`) calls `POST /api/mod/inbox` and
  `sessionController.prompt`.

Limitations: text only, approvals stay in the DSH terminal, and Habblaud World does not accept the DSH provider yet.

Guide: [LINK]
Patch: [PATCH LINK]

Feedback welcome — especially from Linux users and multi-account setups.

## Hacker News / Show HN

**Show HN: DeepSeek Harness in Habblaud — a pixel-art office for your agents**

Habblaud is a local pixel-art office that shows what your coding agents are doing. It already supported Claude Code
and Codex; I added DeepSeek Harness.

DSH stores sessions as zstd JSONL with no hook system, so a bridge replays the session events into Habblaud's API. A
Cordis plugin inside DSH polls Habblaud's inbox and injects messages through `sessionController.prompt`. Everything is
local and reads session data only.

The fun part was mapping DSH's event vocabulary (turn, tool, approval, token usage) into Habblaud's office model and
building a terminal mirror without touching the original compressed log.

Guide + patch: [LINK]

Happy to answer questions about the bridge, the plugin, or the provider model.

## Instagram / TikTok caption

Your agent office now has DeepSeek Harness. 🤖

Open session → character with a DSH badge.
Terminal with the conversation.
Messages from Habblaud into the session.

All local. Guide in bio.

#DeepSeek #Habblaud #DevLife #AI

## Before publishing

- [ ] Publish the guide + patch in a public repo or Gist.
- [ ] Replace `[GUIDE LINK]` and `[PATCH LINK]`.
- [ ] Attach `habblaud-dsh.png`, `habblaud-dsh-usage.png`, `habblaud-dsh-terminal.png`.
- [ ] If possible, record a 10–15 s GIF: character working + message arriving in the terminal.
- [ ] State clearly that this is experimental and not upstream.
