#!/usr/bin/env python3
"""Self-test for decision-label-guard.py; exits non-zero on any failure.
Runs without any user config (WORK_MODE_CONFIG points at a missing file), then once with a custom one."""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

HOOK = Path(__file__).with_name("decision-label-guard.py")
os.environ["WORK_MODE_CONFIG"] = os.path.join(tempfile.gettempdir(), "work-mode-selftest-no-such-file.json")


def load():
    spec = importlib.util.spec_from_file_location("g", HOOK)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


g = load()

CASES = [
    ("zh labeled items pass", "完成。\n\n**待你決定**\n1. [取捨] 要不要做 A？\n   - 建議做\n2. [對外] 寄信給客戶？\n", 0),
    ("zh unlabeled item blocks", "**待你決定**\n1. 下載成績單要你點頭\n2. [金流] 退款\n", 1),
    ("zh none inline passes", "做完了。\n\n**待你決定**：沒有。\n", 0),
    ("zh heading none passes", "## 待你決定\n沒有要你決定的。\n", 0),
    ("no section passes", "全部做完。\n", 0),
    ("nested bullets ignored", "**待你決定**\n1. [權限] 分享資料夾\n   - 我的建議：做\n   - 不做的話：讀不到\n", 0),
    ("section ends at next bold heading", "**待你決定**\n1. [取捨] 選 A\n\n**已照辦**\n- 修好 lint\n", 0),
    ("code fence ignored", "```\n**待你決定**\n1. 假的\n```\n", 0),
    ("fullwidth label passes", "**待你決定**\n- 【對外】回覆客戶\n", 0),
    ("zh dash items block", "**待你決定**\n- 要不要重開 Claude Code\n", 1),
    ("plain text line ends section", "**待你決定**\n- [取捨] 刪 A？\n\n資料來源：\n- [論文](https://x)\n", 0),
    ("en labeled items pass", "Done.\n\n## Decisions Needed\n1. [outbound] Send the reply to the client?\n2. [Payment] Refund?\n", 0),
    ("en unlabeled item blocks", "**Decisions Needed**\n- Should I restart the server?\n", 1),
    ("en none inline passes", "**Decisions Needed**: none.\n", 0),
    ("en pending heading none", "## Pending Decisions\nNo pending decisions.\n", 0),
    ("en heading that is only a prefix is not the section", "## Decisions needed for the architecture\n- We chose SQLite\n- Caching stays\n", 0),
    ("zh heading with more words is not the section", "## 待你決定的背景\n- 說明一\n", 0),
    ("heading with count and colon inside bold", "**待你決定（2 項）：**\n1. 沒標籤\n", 1),
    ("bold heading with inline none inside bold", "**待你決定：沒有**\n", 0),
    ("heading with trailing colon", "Decisions Needed:\n- restart the server?\n", 1),
    ("natural zh heading 要你決定的兩件事 is checked", "**要你決定的兩件事**\n1. 重開伺服器\n2. [對外] 寄信\n", 1),
    ("natural zh heading 要你決定的 is checked", "## 要你決定的\n- 換版面\n", 1),
    ("natural zh heading 要你決定的地方 labeled passes", "**要你決定的地方**\n- [權限] 開分享\n", 0),
    ("en empty-state item passes", "## Decisions Needed\n- No work is pending.\n", 0),
    ("en none item passes", "## Decisions Needed\n- None.\n", 0),
    ("zh empty-state item passes", "**待你決定**\n- 沒有\n", 0),
    ("zh heading 需要你決定 3 件事 is checked", "## 需要你決定 3 件事\n- 重開伺服器\n", 1),
    ("zh heading 要你決定一件 is checked", "**要你決定一件**\n- 換版面\n", 1),
    ("zh heading 要你決定的有三件 is checked", "要你決定的有三件：\n1. 換版面\n", 1),
    ("zh heading 待決事項（2） labeled passes", "### 待決事項（2）\n- [刪除] 清掉舊備份\n", 0),
    ("zh descriptive heading with decide phrase is not the section", "## 要你決定的設計原則\n- 說明一\n", 0),
    ("zh prose sentence is not a heading", "這件事最後要你決定，我先整理好。\n- 說明一\n", 0),
    ("zh item starting with 無 is still checked", "**待你決定**\n- 無法判斷，請你決定是否付款。\n", 1),
    ("zh item starting with 沒有 is still checked", "**待你決定**\n- 沒有備份，要不要先刪舊檔？\n", 1),
    ("zh whole empty statement passes", "**待你決定**\n- 目前沒有要你決定的事。\n", 0),
    ("en item starting with No is still checked", "## Decisions Needed\n- No backup exists, delete the old files?\n", 1),
    ("en no-decisions item passes", "## Decisions Needed\n- No decisions needed.\n", 0),
    ("zh inline decision is the item, list is its detail", "**有一件事要你決定：key 外洩要不要輪換**\n- 外洩範圍：只在本機\n- 防再犯：已改\n", 1),
    ("zh inline labeled decision passes with indented detail", "**有一件事要你決定：** [權限] key 要不要輪換\n  - 外洩範圍：只在本機\n", 0),
    ("zh inline 目前沒有 passes", "**待你決定**：目前沒有。\n", 0),
    ("zh inline empty with follow-up passes", "**待你決定：** 目前沒有需要你裁決的事，只剩部署驗證，我會自己查。\n", 0),
    ("zh inline 目前沒有，等回報 passes", "**待你決定：** 目前沒有，等 agy 回報。\n", 0),
    ("zh inline count then unlabeled list blocks", "待你決定：1 件。\n- 重開伺服器\n", 1),
    ("zh inline count then labeled list passes", "待你決定：1 件（取代上一則）。\n- [對外] 寄信\n", 0),
    ("zh inline 目前沒有新的 passes", "**要你決定的**：目前沒有新的。等另外 3 個做完再給你看。\n", 0),
    ("zh inline unlabeled decision blocks", "**要你決定**：要不要把門檻調低？\n", 1),
    ("zh inline labeled decision passes", "**要你決定**：[權限] 要不要開分享？\n", 0),
    ("zh heading with long bracket note is checked", "要你決定的（封存＝搬進 `_archived`，隨時搬得回來）：\n1. 封存 design-revamp\n", 1),
    ("zh heading count plus noun is checked", "**待你決定的 2 條教訓**（同意的話我寫進 skill）：\n1. 上傳會失敗\n", 1),
    ("zh heading noun without count is not the section", "## 待你決定的教訓\n- 說明一\n", 0),
    ("r4 inline question is not empty", "待你決定：沒有待決事項嗎？請確認是否付款。\n", 1),
    ("r4 empty then question is checked", "**待你決定**\n- 目前沒有，是否要刪資料？\n", 1),
    ("r4 inline item does not absorb top-level bullets", "待你決定：[對外] 寄信？\n- 是否付款？\n", 1),
    ("r4 count plus longer topic is checked", "## 需要你決定的兩個重要安全權限設定\n- 開分享\n", 1),
    ("r4 summary sentence is not a heading", "有 3 件要你決定。\n- 修好 lint\n- 跑完測試\n", 0),
    ("r4 count with trailing colon scans the list", "待你決定：2 件：\n- [對外] 寄信\n- [金流] 退款\n", 0),
    ("r4 empty then later sentence with question word passes", "**要你決定的**：目前沒有。下一個是結果表出來後，要不要進 LoRA。\n", 0),
    ("zh empty statement then suggestion passes", "**還要你決定的：**\n- 沒有需要你決定的事。建議現在跑 `/checkpoint` 收尾。\n", 0),
    ("zh labeled item plus nothing-else line passes", "**還要你決定的：**\n- [金流] 維持要問？\n- 其他沒有了。建議跑 `/checkpoint` 收尾。\n", 0),
    ("zh besides-this nothing passes", "**還要你決定的**\n- [取捨] 收不收那批改動：好處是一致，代價是要多審\n- 除了這項，沒有其他還沒收的事，可以收尾。\n", 0),
    ("en item starting with No but asking blocks", "## Decisions Needed\n- Notify the client now?\n", 1),
    ("mixed: zh label under en heading passes", "**Decisions Needed**\n1. [權限] share the folder\n", 0),
]
TRADE = [
    ("zh tradeoff with both merits passes", "**待你決定**\n1. [取捨] 版面 A 或 B？A 的好處是字大；B 的好處是一頁放完\n", 0),
    ("zh tradeoff natural prose passes", "**待你決定**\n1. [取捨] 信件要不要豁免 HTML？豁免好在像真人回信，但會少了品牌框線\n", 0),
    ("zh merits on nested lines pass", "**待你決定**\n1. [取捨] 版面 A 或 B？\n   - A 的好處：字大\n   - B 的代價：要捲動\n", 0),
    ("zh one-sided tradeoff blocks", "**待你決定**\n1. [取捨] 三條要全改嗎？建議全改，理由是同一類錯\n", 1),
    ("non-tradeoff labels skip merit check", "**待你決定**\n1. [對外] 寄信給客戶？建議寄\n", 0),
    ("en tradeoff with pros and cons passes", "## Decisions Needed\n1. [tradeoff] Layout A or B? A pros: bigger text; B pros: fits one page\n", 0),
    ("en one-sided tradeoff blocks", "## Decisions Needed\n1. [tradeoff] Change all three? I recommend it.\n", 1),
    ("en word inside another word is not a merit", "## Decisions Needed\n1. [tradeoff] Reprocess the prosody files?\n", 1),
]
fail = 0


def check(name, ok, got=""):
    global fail
    print(("PASS" if ok else "FAIL"), name, got)
    fail += not ok


for name, msg, want in TRADE:
    got = len(g.one_sided(msg))
    check(name, (got > 0) == bool(want), got)
for name, msg, want in CASES:
    got = len(g.unlabeled(msg))
    check(name, (got > 0) == bool(want), got)


def run(msg, env=None, **extra):
    payload = dict(last_assistant_message=msg, **extra)
    return subprocess.run([sys.executable, str(HOOK)], input=json.dumps(payload), capture_output=True, text=True,
                          env={**os.environ, **(env or {})})


r = run(CASES[1][1])
check("e2e block", '"decision": "block"' in r.stdout)
check("e2e zh reason has no personal name", ("Dus" + "tin") not in r.stdout and "使用者" in r.stdout)
r = run(CASES[12][1])
check("e2e en reason is English", "Items in the decisions section have no label" in json.loads(r.stdout or "{}").get("reason", ""))
r = run(CASES[1][1], stop_hook_active=True)
check("e2e second pass", r.stdout.strip() == "")
r = subprocess.run([sys.executable, str(HOOK)], input="not json", capture_output=True, text=True)
check("e2e bad input fails open", r.returncode == 0 and r.stdout.strip() == "")

# auto guard: offer-questions in the closing lines block only while the session has auto on
OFFERS = [
    ("zh offer blocks", "已照辦：改好三處。\n\n要我先擬好回信嗎？\n", 1),
    ("zh 需要我 blocks", "整理完了。需要我把這段也補進主檔嗎？\n", 1),
    ("zh deletion confirmation passes", "結果如上。要不要我順便把舊檔刪掉？\n", 0),
    ("zh 我可以…嗎 blocks", "報表好了。我可以先把它搬到 Downloads 嗎？\n", 1),
    ("zh labeled hard stop passes", "**待你決定**\n- [對外] 要不要我把草稿寄給客戶？建議寄。\n", 0),
    ("zh statement passes", "已照辦：三個檔案都改好並 commit。沒有要你決定的事。\n", 0),
    ("zh question inside draft block passes", "草稿如下：\n```\n要不要我幫您預約？\n```\n已存成草稿。\n", 0),
    ("zh early question outside tail passes", "你問過：要我先處理嗎？答案是沒有。\n\n說明一。\n說明二。\n說明三。\n全部做完了。\n", 0),
    ("send confirmation passes", "你希望我向客戶寄出這封信嗎？", 0),
    ("production deletion confirmation passes", "你要我刪除正式資料庫嗎？", 0),
    ("account fact request passes", "Can you tell me which account is yours?", 0),
    ("en offer blocks", "Done with the refactor.\n\nShall I go ahead and update the README as well?\n", 1),
    ("en want me blocks", "Tests pass. Do you want me to squash the commits?\n", 1),
    ("en labeled passes", "## Decisions Needed\n- [outbound] Should I send the reply to the client? I recommend yes.\n", 0),
    ("en statement passes", "All done; the three files are committed.\n", 0),
    ("quoted user words pass", "> 要不要我幫你訂？\n上面是他原話，我已照辦。\n", 0),
    ("zh say-the-word offer blocks", "已套品牌色。要的話回一聲，我就移。\n", 1),
    ("zh nod offer blocks", "草稿備好了，你點頭我就改進主檔。\n", 1),
    ("en say-the-word offer blocks", "The patch is ready. Just say so and I'll apply it.\n", 1),
]
with tempfile.TemporaryDirectory() as d:
    env = {"TEMPO_STATE_DIR": d}
    with open(os.path.join(d, "sid-auto"), "w") as f:
        json.dump({"modes": ["autonomous", "converge"]}, f)
    with open(os.path.join(d, "sid-wrap"), "w") as f:
        json.dump({"modes": ["converge"]}, f)
    for invalid in (123, "not-autonomous", ["autonomous", 123]):
        with open(os.path.join(d, "sid-invalid"), "w") as f:
            json.dump({"modes": invalid}, f)
        r = run(OFFERS[0][1], env, session_id="sid-invalid")
        check("auto invalid modes " + repr(invalid), r.returncode == 0 and r.stdout.strip() == "")
    for name, msg, want in OFFERS:
        r = run(msg, env, session_id="sid-auto")
        check("auto " + name, ('"decision": "block"' in r.stdout) == bool(want), r.stdout[:80])
    r = run(OFFERS[0][1], env, session_id="sid-wrap")
    check("auto guard is silent without auto", r.stdout.strip() == "")
    r = run(OFFERS[0][1], env, session_id="../sid-auto")
    check("auto guard ignores a traversal sid", r.stdout.strip() == "")
    r = run(OFFERS[0][1], env, session_id="sid-auto")
    check("auto reason says to do it", "AUTO GUARD" in r.stdout and ("Dus" + "tin") not in r.stdout)
    r = run("Done with the refactor.\n\nShall I go ahead and update the README as well?\n", env, session_id="sid-auto")
    check("auto en reason is English", "AUTO GUARD: the reply ends" in json.loads(r.stdout or "{}").get("reason", ""))

# wrap guard: a decisions section whose items were all shown before is blocked
def transcript(path, *replies, user="繼續"):
    with open(path, "w", encoding="utf-8") as f:
        for r in replies:
            f.write(json.dumps({"type": "user", "message": {"role": "user", "content": user}}) + "\n")
            f.write(json.dumps({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": r}]}}) + "\n")


A = "做好了。\n\n**待你決定**\n1. [對外] 要不要把草稿寄給客戶？建議寄。\n2. [金流] 退款 300 元？建議退。\n"
B = "又做了一些。\n\n**待你決定**\n1. [對外] 要不要把草稿寄給客戶？建議寄。\n2. [金流] 退款 300 元？建議退。\n"
C = "又做了一些。\n\n**待你決定**\n1. [對外] 要不要把草稿寄給客戶？建議寄。\n2. [刪除] 清掉舊備份？建議清。\n"
D = "最終回報。\n\n**待你決定**\n1. [對外] 要不要把草稿寄給客戶？建議寄。\n2. [金流] 退款 300 元？建議退。\n"
E = "都做完了。還有 2 項待決。\n"
with tempfile.TemporaryDirectory() as d:
    env = {"TEMPO_STATE_DIR": d}
    with open(os.path.join(d, "sid-wrap"), "w") as f:
        json.dump({"modes": ["converge"]}, f)
    with open(os.path.join(d, "sid-auto"), "w") as f:
        json.dump({"modes": ["autonomous"]}, f)
    tp = os.path.join(d, "t.jsonl")
    transcript(tp, A)
    r = run(B, env, session_id="sid-wrap", transcript_path=tp)
    check("wrap repost blocks", "WRAP GUARD" in r.stdout, r.stdout[:60])
    transcript(tp, A, B)  # the transcript already holds the reply being judged
    r = run(B, env, session_id="sid-wrap", transcript_path=tp)
    check("wrap repost blocks when transcript holds the reply", "WRAP GUARD" in r.stdout)
    transcript(tp, A)
    r = run(C, env, session_id="sid-wrap", transcript_path=tp)
    check("wrap one new item passes", r.stdout.strip() == "", r.stdout[:60])
    r = run(D, env, session_id="sid-wrap", transcript_path=tp)
    check("wrap final report passes", r.stdout.strip() == "")
    r = run(E, env, session_id="sid-wrap", transcript_path=tp)
    check("wrap open-count line passes", r.stdout.strip() == "")
    transcript(tp, A, user="把待你決定的全部列出來")
    r = run(B, env, session_id="sid-wrap", transcript_path=tp)
    check("wrap relist on request passes", r.stdout.strip() == "")
    transcript(tp, A)
    r = run(B, env, session_id="sid-auto", transcript_path=tp)
    check("wrap guard is silent without wrap", r.stdout.strip() == "")
    r = run(A, env, session_id="sid-wrap", transcript_path=tp.replace(".jsonl", ".missing.jsonl"))
    check("wrap guard fails open without a transcript", r.stdout.strip() == "")
    transcript(tp, "早安。\n")
    r = run(A, env, session_id="sid-wrap", transcript_path=tp)
    check("wrap first showing passes", r.stdout.strip() == "")

# custom labels and heading from a config file
with tempfile.TemporaryDirectory() as d:
    cfg = os.path.join(d, "config.json")
    with open(cfg, "w", encoding="utf-8") as f:
        json.dump({"converge": {"sectionHeading": "Open Questions", "decisionLabels": ["external", "money", "choice"],
                                "tradeoffLabel": "choice"}}, f)
    env = {"WORK_MODE_CONFIG": cfg}
    r = run("## Open Questions\n1. [money] refund?\n2. [choice] A or B? I lean A\n", env)
    out = json.loads(r.stdout or "{}").get("reason", "")
    check("custom heading recognised, one-sided custom tradeoff blocks", "[choice]" in out)
    r = run("## Open Questions\n1. [outbound] send it?\n", env)
    check("custom labels replace the defaults", '"decision": "block"' in r.stdout)
    r = run("## Open Questions\n1. [external] send it?\n", env)
    check("custom label passes", r.stdout.strip() == "")
    with open(cfg, "w", encoding="utf-8") as f:
        f.write("{ broken")
    r = run("**待你決定**\n1. [取捨] A 的好處…；B 的好處…\n", env)
    check("broken config falls back to defaults", r.stdout.strip() == "")

sys.exit(1 if fail else 0)
