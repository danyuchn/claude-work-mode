#!/usr/bin/env python3
"""decision-label-guard.py — Stop hook (work-mode-gates).

A reply's decisions section ("Decisions Needed" / 待你決定 and similar headings) may only
hold items the user must decide. Every top-level item there must carry one label:
  [outbound] [payment] [delete] [permission] [tradeoff]   or   [對外] [金流] [刪除] [權限] [取捨]
An item that fits none is something the model should just do, so the reply is blocked
until it is done or relabelled.

A tradeoff item must also name what each side gains (at least two merit words such as
pros / cons / risk / 好處 / 代價 in the item and its indented lines); one that cannot is a
recommendation the model should just carry out.

Labels and the heading can be customised in the work-mode config file
(${WORK_MODE_CONFIG:-~/.config/work-mode/config.json}: converge.decisionLabels,
converge.tradeoffLabel, converge.sectionHeading). Without one, both label sets are accepted.

Under /work-mode wrap, a decisions section whose every item already appeared, unchanged, in one of
the last few replies (read from the transcript tail) is blocked: wrap shows a decision once and then
only the open count, except in a final report or when asked to relist.

Under /work-mode auto (the session's modes file in ~/.claude/state/tempo, or $TEMPO_STATE_DIR),
the reply's closing lines may not end on an offer-question to the user ("要我先擬好嗎？",
"Shall I go ahead and ...?"): auto means do it, or put a hard stop on the pending list with a
label and a recommendation. A line that carries a decision label is left alone.

Fail-open on parse problems; the second pass (stop_hook_active) always passes.
"""
import json
import os
import re
import sys

DEFAULT_LABELS = ["對外", "金流", "刪除", "權限", "取捨", "outbound", "payment", "delete", "permission", "tradeoff"]
DEFAULT_TRADEOFF = ["取捨", "tradeoff"]
HEADINGS = r"待你決定|要你決定|需要你決定|待決事項|Decisions?\s+Needed|Pending\s+Decisions?|Needs?\s+Your\s+Decision"


def load_config():
    path = os.environ.get("WORK_MODE_CONFIG") or "~/.config/work-mode/config.json"
    try:
        with open(os.path.expanduser(path), encoding="utf-8") as f:
            data = json.load(f)
        conv = data.get("converge") or {}
        return conv if isinstance(conv, dict) else {}
    except (OSError, ValueError, AttributeError):
        return {}


def _strings(v):
    return [s for s in v if isinstance(s, str) and s.strip()] if isinstance(v, list) else []


_conf = load_config()
LABELS = _strings(_conf.get("decisionLabels")) or DEFAULT_LABELS
_trade = _conf.get("tradeoffLabel")
TRADEOFFS = [_trade] if isinstance(_trade, str) and _trade.strip() else DEFAULT_TRADEOFF
_heading = _conf.get("sectionHeading")
_extra = "|" + re.escape(_heading) if isinstance(_heading, str) and _heading.strip() else ""


def _alt(words):
    return "|".join(re.escape(w) for w in words)


LABEL = re.compile(r"[\[【]\s*(" + _alt(LABELS) + r")\s*[\]】]", re.I)
TRADEOFF = re.compile(r"[\[【]\s*(" + _alt(TRADEOFFS) + r")\s*[\]】]", re.I)
# The heading must be the whole line: optional markdown (#, **), an optional count in brackets,
# then either the end of the line or a colon with an inline remainder ("**待你決定**：沒有").
# "## Decisions needed for the architecture" is an ordinary heading, not this section.
_TAIL = r"\s*(?:\*\*)?\s*(?:[（(][^()（）\n]{0,40}[)）])?\s*(?:\*\*)?\s*(?:[：:].*)?$"
HEADING = re.compile(r"^\s*(#+\s*|\*\*)?\s*(" + HEADINGS + _extra + r")" + _TAIL, re.I)
# Chinese headings come in too many word orders to list (要你決定的兩件事, 需要你決定 3 件事,
# 要你決定的有三件). A short heading line counts when it holds a decide phrase and every other
# character is filler (的, 有, a count, 件/項/事...), so 「待你決定的背景」 stays an ordinary heading.
_ZH_DECIDE = re.compile(r"(?:需要|要|請|待|由)?\s*(?:你|您)\s*(?:來)?\s*(?:做)?\s*決定|待決(?:事項)?")
_ZH_FILLER = set("的有共還這些以下下列如需要請事項件個點條處地方問題情目一二兩三四五六七八九十0123456789 \t")
_ZH_COUNT = re.compile(r"[\d一二兩三四五六七八九十]+\s*[件項個點條]")
_ZH_LINE = re.compile(
    r"^\s*(?:#+\s*|\*\*)?\s*(?P<core>[^：:*（(。？！?!\n]{1,24}?)\s*(?:\*\*)?\s*"
    r"(?:[（(][^()（）\n]{0,40}[)）])?\s*(?:\*\*)?\s*(?:[：:].*)?$")


def is_heading(line: str) -> bool:
    line = line.strip()[:300]  # bounded, so the regexes stay linear on long or blank-heavy lines
    if HEADING.match(line):
        return True
    m = _ZH_LINE.match(line)
    if not m:
        return False
    core = m.group("core")
    d = _ZH_DECIDE.search(core)
    if not d:
        return False
    rest = core[:d.start()] + core[d.end():]
    if all(c in _ZH_FILLER for c in rest):
        return True
    # with a count ("待你決定的 2 條教訓") a short noun may follow it
    c = _ZH_COUNT.search(rest)
    return bool(c) and all(ch in _ZH_FILLER for ch in rest[:c.end()]) and len(rest[c.end():].strip()) <= 12


ITEM = re.compile(r"^(\d+[.)、]|[-*])\s+\S")
# A list item whose WHOLE statement says nothing is pending ("- No work is pending.", "- 沒有", "- 無").
# "- 無法判斷，請你決定是否付款" starts with 無 but is a real item, so the match is anchored at the end.
EMPTY_ITEM = re.compile(
    r"^(?:\d+[.)、]|[-*])\s+(?:"
    r"(?:(?:除了這項|除此之外|其他|另外)[，,]?\s*)?(?:目前|暫時|這輪|本輪)?(?:沒有|無)(?:任何|其他|別的|新的)?"
    r"(?:要你(?:決定|裁決)|需要你?(?:決定|裁決)|待決|待你決定|還沒收|未完成)?(?:的)?(?:事情|事項|事|項目)?了?"
    r"|其他沒有了|none|nothing(?:\s+(?:else\s+)?(?:pending|open|to\s+decide))?|n/a"
    r"|no\b[^.,;:\n]{0,40}\b(?:pending|open|needed|to\s+decide)"
    # the empty statement must be the whole first clause; a closing suggestion may follow
    r")\s*(?:[。.！!，,](?:\s.*|[^\s].*)?)?\s*$",
    re.I,
)
# "待你決定：1 件。" / "Decisions needed: 2" — a count only; the items are the list below.
COUNT_ONLY = re.compile(r"^[\d一二兩三四五六七八九十]+\s*(?:[件項個點條]|items?)?\s*(?:事|事項)?\s*[。.]?\s*(?:[（(][^()（）]*[)）])?\s*[。.：:]?$", re.I)
# a clause after the empty statement that asks something makes the item a real decision
QUESTION = re.compile(r"[？?]|嗎|要不要|是否|還是|請確認|請你|should\b|whether\b", re.I)


def is_empty(item: str) -> bool:
    # only the first sentence counts: "目前沒有，是否要刪資料？" asks, "目前沒有。之後要不要…" does not
    first = re.match(r"[^。.！!？?]*[。.！!？?]?", item).group(0)
    return bool(EMPTY_ITEM.match(item)) and not QUESTION.search(first)
BREAK = re.compile(r"^\s*(#+\s|\*\*[^*]+\*\*\s*$)")
MERIT = re.compile(
    r"好處|優點|優勢|代價|缺點|風險|好在|勝在|省下|省去|換來|但會|不過會|只是會|但要|不過要|卻會|少了|失去"
    r"|\b(pros?|cons?|benefits?|upsides?|downsides?|gains?|costs?|risks?|advantages?|disadvantages?|drawbacks?)\b",
    re.I,
)
ENGLISH_HEADING = re.compile(r"^\s*(#+\s*|\*\*)?\s*(Decisions?\s+Needed|Pending\s+Decisions?|Needs?\s+Your\s+Decision)" + _TAIL, re.I)


def unlabeled(msg: str) -> list:
    return [b[0].strip()[:60] for b in _items(msg) if not LABEL.search(b[0])]


def one_sided(msg: str) -> list:
    """Tradeoff items that never say what either option gains."""
    return [b[0].strip()[:60] for b in _items(msg)
            if TRADEOFF.search(b[0]) and len(MERIT.findall("\n".join(b))) < 2]


def _items(msg: str) -> list:
    text = re.sub(r"```.*?```", " ", msg, flags=re.S)
    lines = text.splitlines()
    out = []
    i = 0
    while i < len(lines):
        if not is_heading(lines[i]):
            i += 1
            continue
        head = lines[i]
        rest = re.sub(r"^[^：:]*[：:]", "", head, count=1) if re.search(r"[：:]", head) else ""
        inline = rest.strip(" *")
        if inline and is_empty("- " + inline):
            i += 1
            continue
        i += 1
        if inline and not COUNT_ONLY.match(inline):
            # "**要你決定**：<the decision>": the inline text is an item; every top-level
            # bullet below is still checked as its own item, indented lines are its detail
            out.append([inline])
        while i < len(lines):
            ln = lines[i]
            # any unindented non-item text (e.g. a "Sources:" line) closes the section
            if not ITEM.match(ln) and (BREAK.match(ln) or (ln.strip() and not ln[0].isspace())):
                break
            if ITEM.match(ln) and is_empty(ln):
                pass
            elif ITEM.match(ln):
                out.append([ln])
            elif out and ln.strip():
                out[-1].append(ln)
            i += 1
    return out


# An offer to do an internal step, phrased as a question, in the reply's closing lines.
OFFER_ZH = re.compile(
    r"(?:要不要|需不需要|是否(?:需)?要|還要不要|要|需要|想要|希望)\s*我\s*(?:們)?\s*(?:先|再|來|幫你|替你|直接|就)?[^。！!\n]{0,60}?[嗎呢]?\s*[？?]"
    r"|我\s*(?:可以|能|來|現在|先|要不要)[^。！!\n]{0,50}?(?:嗎|好嗎|好不好|行嗎|可以嗎)\s*[？?]"
    # "say the word and I will": the offer without a question mark
    r"|(?:要的話|需要的話|想要的話|你點頭|你說一聲|回一聲|回我一聲)[^。！!\n]{0,12}(?:我(?:就|再|馬上|立刻)|就)[^。！!\n]{0,40}"
)
OFFER_EN = re.compile(
    r"\b(?:shall|should|can|could|may|do you want|would you like|want)\b[^.!?\n]{0,12}\b(?:I|me|us|we)\b[^.!?\n]{0,100}\?"
    r"|\b(?:say the word|just say so|let me know)\b[^.!?\n]{0,20}\b(?:and I|I will|I'll|I can)\b[^.!?\n]{0,80}",
    re.I,
)
TAIL_CHARS = 700
HARD_STOP_OR_FACT = re.compile(r"寄|發送|送出|傳給|刪除|刪掉|付款|退款|轉帳|權限|安裝|密碼|憑證|正式|production|send|email|delete|pay|refund|install|permission|credential|password|deploy|which|哪一個|哪個|你的|your", re.I)


def offers(msg: str) -> list:
    """Offer-questions in the closing lines, outside code blocks and labeled decision items."""
    text = re.sub(r"```.*?```", " ", msg, flags=re.S)
    paragraphs = re.split(r"\n\s*\n", text.rstrip())
    tail = "\n".join((paragraphs[-1], "\n".join(text.splitlines()[-3:])))
    out = []
    for ln in dict.fromkeys(tail.splitlines()):
        if LABEL.search(ln) or HARD_STOP_OR_FACT.search(ln) or ln.lstrip().startswith(">"):
            continue
        for rx in (OFFER_ZH, OFFER_EN):
            m = rx.search(ln)
            if m:
                out.append(m.group(0).strip()[:80])
                break
    return out


def modes_on(data: dict) -> list:
    sid = data.get("session_id")
    if not isinstance(sid, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", sid):
        return []
    base = os.environ.get("TEMPO_STATE_DIR") or os.path.expanduser("~/.claude/state/tempo")
    try:
        with open(os.path.join(base, sid), encoding="utf-8") as f:
            modes = json.load(f).get("modes") or []
        return modes if isinstance(modes, list) and all(isinstance(m, str) for m in modes) else []
    except (OSError, ValueError, AttributeError):
        return []


def auto_on(data: dict) -> bool:
    return "autonomous" in modes_on(data)


# ---- reposted decisions (wrap) -------------------------------------------------------------
# Under wrap a decision item is shown once; later replies end with the open count. The transcript
# tail gives the earlier replies: when every item in this reply's section already appeared in one
# of the last PRIOR_REPLIES assistant replies, unchanged, the reply is blocked. A reply that is
# a final report, or answers a request to relist, passes.
PRIOR_REPLIES = 6
TAIL_BYTES = 2_000_000
RELIST = re.compile(r"最終回報|最後回報|完整清單|全部列|重列|再列一次|列出.{0,6}(?:待|決定)|final report|full list|relist|list (?:them|all)", re.I)


def item_key(item: str) -> str:
    """The item's own words, without label, markers, counts or punctuation, cut short."""
    t = re.sub(r"^(?:\d+[.)、]|[-*])\s+", "", item.strip())
    t = LABEL.sub("", t)
    t = re.sub(r"[\s*_`#【】\[\]（）()：:，,。.、！!？?～~\-]+", "", t)
    return t[:40]


def item_keys(msg: str) -> set:
    return {item_key(b[0]) for b in _items(msg) if item_key(b[0])}


def prior_replies(data: dict) -> list:
    """Assistant texts before the current reply, newest first, from the transcript tail."""
    path = data.get("transcript_path")
    if not isinstance(path, str) or not path.endswith(".jsonl"):
        return []
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as f:
            if size > TAIL_BYTES:
                f.seek(size - TAIL_BYTES)
                f.readline()
            raw = f.read().decode("utf-8", errors="replace")
    except OSError:
        return []
    out = []
    last_user = ""
    for ln in raw.splitlines():
        try:
            d = json.loads(ln)
        except ValueError:
            continue
        if d.get("isSidechain"):
            continue
        msg = d.get("message") or {}
        content = msg.get("content")
        if d.get("type") == "user":
            if isinstance(content, str):
                last_user = content
            elif isinstance(content, list):
                texts = [x.get("text") for x in content if isinstance(x, dict) and x.get("type") == "text"]
                if texts:
                    last_user = "\n".join(t for t in texts if isinstance(t, str))
            continue
        if not isinstance(content, list):
            continue
        texts = [x.get("text") for x in content if isinstance(x, dict) and x.get("type") == "text"]
        texts = [t for t in texts if isinstance(t, str) and t.strip()]
        if texts:
            out.append(("\n".join(texts), last_user))
    return out[::-1]


def reposted(msg: str, data: dict) -> list:
    """Items in this reply's decisions section that an earlier reply already showed, when none is new."""
    keys = item_keys(msg)
    if not keys or RELIST.search(msg):
        return []
    prior = prior_replies(data)
    if not prior:
        return []
    cur = msg.strip()
    # the transcript may already hold this very reply: skip it
    if prior and prior[0][0].strip() == cur:
        prior = prior[1:]
    if prior and RELIST.search(prior[0][1] if len(prior[0]) > 1 else ""):
        return []
    seen = set()
    for text, _ in prior[:PRIOR_REPLIES]:
        seen |= item_keys(text)
    if keys and keys <= seen:
        return sorted(keys)
    return []


def repost_reason(msg: str, found: list) -> str:
    n = len(found)
    if is_english(msg) or not re.search(r"[\u4e00-\u9fff]", msg[-TAIL_CHARS:]):
        return (f"WRAP GUARD: all {n} decision item(s) in this reply were already shown in an earlier reply, unchanged. "
                "Work mode wrap is on: show a decision only when it is new or its status changed; otherwise drop the "
                "section and end with one line giving how many decisions are still open. Relist in full only when asked "
                "or in the final report (say so in the reply).")
    return (f"WRAP GUARD：這則回覆「待你決定」裡的 {n} 項先前都已經列過、狀態沒變。"
            "work mode wrap 開著：只在新增或狀態改變時才列；否則拿掉整段，結尾只用一行寫還有幾項待決。"
            "要完整重列只在他要求、或最終回報時（回覆裡寫明是最終回報）。")


def offer_reason(msg: str, found: list) -> str:
    quoted = "\n  ".join(found)
    if is_english(msg) or not re.search(r"[\u4e00-\u9fff]", msg[-TAIL_CHARS:]):
        return ("AUTO GUARD: the reply ends by offering to do something and asking first:\n  " + quoted +
                "\nWork mode auto is on: an internal, reversible step is yours to do now, then report it done. "
                "Only a hard stop (outgoing message, payment, delete, permission, install, secret, production) "
                "waits, and it goes on the pending list as a labeled item with your recommendation, not as a question.")
    return ("AUTO GUARD：回覆結尾在問要不要做：\n  " + quoted +
            "\nwork mode auto 開著：本機可回復的步驟直接做掉、回報已照辦。只有硬性停點（對外發送、金流、刪除、權限、安裝、憑證、正式環境）"
            "才等他，而且寫成待處理清單裡帶標籤的項目加你的建議，不是問句。")


def is_english(msg: str) -> bool:
    return any(ENGLISH_HEADING.match(ln) for ln in msg.splitlines())


def reason(msg: str, bad: list, weak: list) -> str:
    labels = " ".join("[%s]" % l for l in LABELS)
    trade = "[%s]" % TRADEOFFS[0]
    parts = []
    if is_english(msg):
        if bad:
            parts.append("Items in the decisions section have no label:\n  " + "\n  ".join(bad) +
                         "\nStart each item with one of " + labels + ". An item that fits none is a local, "
                         "reversible step: do it now and list it as done instead of asking the user.")
        if weak:
            parts.append(trade + " items do not say what each side gains:\n  " + "\n  ".join(weak) +
                         "\n" + trade + " is only for two reasonable paths where the choice turns on the user's "
                         "preference; state what each option gains (e.g. \"Option A pros: ...; Option B pros: ...\"). "
                         "If you cannot, only one path is reasonable: follow your recommendation and list it as done.")
        return "DECISION-LABEL GUARD: " + "\n".join(parts)
    if bad:
        parts.append("「待你決定」裡有項目沒標類別：\n  " + "\n  ".join(bad) +
                     "\n每項開頭標 " + labels + " 其一。套不進任何一類的是本機可回復的事，"
                     "直接做掉並移到已照辦，不要停下來問使用者。")
    if weak:
        parts.append(trade + " 項目沒把兩邊各自的得失講清楚：\n  " + "\n  ".join(weak) +
                     "\n" + trade + " 只給「兩條路都合理、看使用者偏好」的事，請用自然連貫的句子講明兩邊各自的得失"
                     "（例如「選 A 好在…但會…；選 B 則能…」）。"
                     "如果講不出兩邊各自的得失，代表這件事只有一條路合理，你該直接照建議做掉並移到已照辦。")
    return "DECISION-LABEL GUARD：" + "\n".join(parts)


def main():
    try:
        data = json.load(sys.stdin)
    except ValueError:
        return
    if not isinstance(data, dict) or data.get("stop_hook_active"):
        return
    msg = data.get("last_assistant_message") or ""
    if not isinstance(msg, str) or not msg:
        return
    bad = unlabeled(msg)
    weak = one_sided(msg)
    modes = modes_on(data)
    found = offers(msg) if "autonomous" in modes else []
    again = reposted(msg, data) if "converge" in modes and not bad else []
    if not bad and not weak and not found and not again:
        return
    parts = []
    if bad or weak:
        parts.append(reason(msg, bad, weak))
    if found:
        parts.append(offer_reason(msg, found))
    if again:
        parts.append(repost_reason(msg, again))
    print(json.dumps({"decision": "block", "reason": "\n".join(parts)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
