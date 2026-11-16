"""Tools served by the tool gateway.

Every public function defined here (name not starting with "_") becomes an MCP
tool. Its docstring is the description the model sees and its type hints are
the input schema. Saving this file restarts the gateway with the new tools.
"""

import json
import multiprocessing
import re
import threading
from datetime import datetime, timezone
from typing import Any

from factory import NotFoundError, blobstore, policies, valid_id

SEARCH_SECONDS = 5.0

REQUIREMENT = re.compile(r"\b(must|should|shall|needs?)\b", re.IGNORECASE)
WORD = re.compile(r"[A-Za-z0-9][A-Za-z0-9'_-]*")
CAPITALIZED = re.compile(r"^[A-Z][A-Za-z0-9_-]+$")
SENTENCE_END = re.compile(r"(?<=[.!?])\s+")
SESSION_ROOT = "user-sessions"
SESSION_FILE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.(md|txt|json)$")
TEAM_ROOT = "teams"
TEAM_FILE_NAME = re.compile(
    r"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.(md|txt|json"
    r"|py|go|js|ts|tsx|jsx|java|kt|rs|c|h|cpp|cs|rb|php|sh|sql|html|css|yaml|yml|toml|xml)$"
)
MAX_MESSAGE_TEXT = 100000
# A queue holds the messages of one sender in one channel; its append is a read-modify-write,
# so each queue has its own lock. Only this process writes the queues of agent members.
QUEUE_LOCKS: dict[str, threading.Lock] = {}
QUEUE_LOCKS_GUARD = threading.Lock()
MAX_SEARCH_MATCHES = 200
MAX_MATCH_TEXT = 500


def get_policy(policy_id: str, version: str = "latest") -> str:
    """Return the Markdown text of a policy from the policy registry.

    policy_id is the policy name, for example "coding-standards". version is a
    version such as "v3", or "latest" for the newest one. If the policy or
    version does not exist, a message saying so is returned instead.
    """
    try:
        policy = policies.get(policy_id, version)
    except NotFoundError:
        return f"Policy {policy_id!r} version {version!r} does not exist."
    return policy["files"]["policy.md"]


def get_artifact(object_id: str) -> str:
    """Return the text content of an artifact stored in the blobstore.

    object_id is a slash-separated path such as "runs/42/task.md". Each segment
    may contain letters, digits, ".", "_" and "-", and must not start with ".".
    Fails if the artifact does not exist.
    """
    return blobstore.get(object_id)


def put_artifact(object_id: str, content: str, creator: str = "tool-gateway", trace_id: str = "") -> str:
    """Store text content in the blobstore under object_id and return the object_id.

    object_id is a slash-separated path such as "runs/42/plan.md"; an existing
    artifact with that ID is replaced. creator names who produced the content
    and trace_id links it to a workflow run; both are stored as metadata.
    """
    blobstore.put(object_id, content, creator, trace_id)
    return object_id


def list_artifacts(prefix: str = "") -> dict:
    """List the immediate children of a prefix in the blobstore.

    prefix is a slash-separated directory such as "runs/42", or "" for the top
    level. Returns {"prefix", "directories": [names], "objects": [{"id", "size",
    "created", "creator", "trace_id"}]}. Fails if the prefix does not exist.
    """
    return blobstore.list(prefix)


def analyze_task_complexity(object_id: str) -> dict:
    """Estimate how complex the task described in a blobstore artifact is.

    The assessment is a deterministic heuristic, not a judgement of meaning:
    - words: number of words.
    - sentences: number of sentences (text split at ".", "!" or "?" and at line breaks).
    - requirements: sentences containing "must", "should", "shall", "need" or "needs".
    - components: distinct capitalized words that do not start a sentence,
      a rough proxy for the number of systems or components mentioned.
    - score from 1 to 5: starts at 1 and adds one point each for more than 200
      words, more than 800 words, 5 or more requirements, and 10 or more components.
    - reasons: one short string per point added, or one saying the task is small.
    """
    return {"object_id": object_id, **_assess(blobstore.get(object_id))}


def list_session_files(session: str) -> dict:
    """List the files of an interactive chat session.

    session is the session path given in your instructions, for example
    "user-sessions/<trace-id>/<step-id>"; pass it unchanged. A team member
    passes its team path, for example "teams/<trace-id>/<step-id>", to list the
    workspace files that all members of the team share. Returns
    {"session", "files": [{"name", "size"}]} with size in bytes. The list is
    empty when the session has no files yet. Use the names with
    read_session_file, search_session_files and write_session_file.
    """
    return {"session": _session(session), "files": _session_files(session)}


def read_session_file(session: str, name: str, start_line: int = 0, end_line: int = 0) -> str:
    """Return a session file as numbered lines, like "cat -n".

    session is the session path (or team path) given in your instructions. name
    is a file name from list_session_files, for example "notes.md". Lines are
    numbered from 1.
    start_line and end_line select an inclusive range: start_line=10,
    end_line=20 returns lines 10 to 20. 0 means open: start_line=0 starts at the
    first line and end_line=0 reads to the last line, so leaving both at 0
    returns the whole file. An end_line past the end of the file stops at the
    last line. Each output line is the line number, a tab, then the text. If the
    range is outside the file, a message with the file's line count is returned
    instead. Fails if the file does not exist.
    """
    lines = blobstore.get(_session_file(session, name)).splitlines()
    total = len(lines)
    if start_line < 0 or end_line < 0:
        return f"Invalid range: start_line and end_line must be 0 or greater. {name} has {total} lines."
    if total == 0:
        return f"{name} is empty."
    first = start_line or 1
    last = min(end_line or total, total)
    if first > total:
        return f"Line {first} is outside {name}, which has {total} lines."
    if last < first:
        return f"Invalid range: end_line {end_line} is before start_line {first}. {name} has {total} lines."
    return "\n".join(f"{number:6d}\t{lines[number - 1]}" for number in range(first, last + 1))


def search_session_files(session: str, pattern: str, name: str = "") -> dict:
    """Search the session files line by line with a regular expression.

    session is the session path (or team path) given in your instructions.
    pattern is a Python "re" regular expression matched anywhere in a line; it is case-sensitive
    unless it starts with "(?i)". name limits the search to one file from
    list_session_files; leave it "" to search every file of the session.
    Returns {"matches": [{"file", "line", "text"}], "truncated"}: line is the
    1-based line number, usable as start_line and end_line of read_session_file,
    and text is the matching line (shortened when very long). At most 200
    matches are returned; "truncated" is true when there were more, so narrow
    the pattern or search a single file. Fails with a message when pattern is
    not a valid regular expression.
    """
    try:
        regex = re.compile(pattern)
    except (re.error, OverflowError, RecursionError) as exc:
        raise ValueError(f"invalid regular expression {pattern!r}: {exc}") from exc
    names = [name] if name else [entry["name"] for entry in _session_files(session)]
    texts = [(file_name, blobstore.get(_session_file(session, file_name))) for file_name in names]
    return _within(SEARCH_SECONDS, lambda: _search(regex, texts), "the search took too long; simplify the pattern")


def _search(regex: re.Pattern[str], texts: list[tuple[str, str]]) -> dict[str, Any]:
    matches: list[dict[str, Any]] = []
    for file_name, text in texts:
        for number, line in enumerate(text.splitlines(), start=1):
            if not regex.search(line):
                continue
            if len(matches) == MAX_SEARCH_MATCHES:
                return {"matches": matches, "truncated": True}
            matches.append({"file": file_name, "line": number, "text": line[:MAX_MATCH_TEXT]})
    return {"matches": matches, "truncated": False}


def _within(seconds: float, work: Any, message: str) -> Any:
    """Run work in a child process and stop it after seconds.

    Python's re has no timeout, and a pattern such as (a+)+$ can run for hours on
    one line; a child process is the only way to stop it.
    """
    context = multiprocessing.get_context("fork")
    receiver, sender = context.Pipe(duplex=False)

    def run() -> None:
        try:
            sender.send((True, work()))
        except Exception as exc:  # reported to the caller below
            sender.send((False, str(exc)))

    child = context.Process(target=run, daemon=True)
    child.start()
    sender.close()
    try:
        if not receiver.poll(seconds):
            raise ValueError(message)
        ok, value = receiver.recv()
    finally:
        if child.is_alive():
            child.terminate()
        child.join(1)
        receiver.close()
    if not ok:
        raise ValueError(value)
    return value


def write_session_file(session: str, name: str, content: str) -> str:
    """Store text as a file of the session and return its object ID.

    session is the session path given in your instructions. name is the file
    name: it starts with a letter or digit, may contain letters, digits, ".",
    "_" and "-", and must end in ".md", ".txt" or ".json", for example
    "summary.md". No folders. content is the complete new text of the file; an
    existing file with that name is replaced, so to change a file read it first
    and write back the whole text.

    When session is a team path such as "teams/<trace-id>/<step-id>", the file
    goes into the workspace shared by all team members, and code files are
    allowed too: .py .go .js .ts .tsx .jsx .java .kt .rs .c .h .cpp .cs .rb .php
    .sh .sql .html .css .yaml .yml .toml .xml, for example
    write_session_file(session="teams/t1/build", name="main.py", content="print(1)").
    """
    object_id = _session_file(session, name)
    blobstore.put(object_id, content, "tool-gateway", session.split("/")[1])
    return object_id


def list_channels(team: str, member: str) -> dict:
    """List your message channels in a team: who is on the other end and how many unread messages wait.

    team is the team path given in your instructions, for example
    "teams/<trace-id>/<step-id>"; pass it unchanged. member is your own member
    name in the team, also given in your instructions, for example "coder".
    Example: list_channels(team="teams/t1/build", member="coder").
    Returns {"team", "member", "channels": [{"id", "with", "description",
    "unread", "direction"}]}. id is the channel ID to pass to send_message and
    read_messages. with is the name of the other member on that channel and
    description says what that member does. unread is the number of messages
    from the other member that you have not been given yet. direction is
    "both" when you and the other member may send, "send" when only you may
    send, and "receive" when only the other member may send. A channel connects
    exactly two members; you can only message members you share a channel with.
    """
    info = _team(team)
    _team_member(info, member)
    descriptions = {entry["name"]: entry.get("description", "") for entry in info.get("members", [])}
    read = _read_markers(team, member)
    channels = []
    for channel in info.get("channels", []):
        if member not in channel["members"]:
            continue
        other = _other(channel, member)
        marker = read.get(channel["id"], 0)
        unread = sum(1 for message in _queue(team, channel["id"], other) if message["seq"] > marker)
        channels.append(
            {"id": channel["id"], "with": other, "description": descriptions.get(other, ""), "unread": unread,
             "direction": _direction(channel, member)}
        )
    return {"team": team, "member": member, "channels": channels}


def send_message(team: str, member: str, channel: str, text: str) -> dict:
    """Send a message to the other member of one of your team channels.

    team is the team path and member is your own member name, both given in
    your instructions. channel is a channel ID from list_channels, for example
    "coder--lead". text is the complete message, at most 100000 characters; it
    must not be empty. Put everything the other member needs into the text, or
    name the workspace file that holds it.
    Example: send_message(team="teams/t1/build", member="lead",
    channel="coder--lead", text="Write main.py as described in input-clarify.md.").
    Returns {"channel", "seq", "to"}: seq is the number of your message among
    those you sent on the channel and to is the member who receives it. The message is delivered
    after your turn ends and the reply arrives later as a new message to you,
    so do not wait for it and do not call read_messages in a loop. Fails with a
    message when the channel is not one of yours; call list_channels to see
    your channels.
    """
    info = _team(team)
    _team_member(info, member)
    entry = _team_channel(info, member, channel)
    if not isinstance(text, str) or not text.strip():
        raise ValueError("text is empty: pass the complete message as text")
    if len(text) > MAX_MESSAGE_TEXT:
        raise ValueError(
            f"text has {len(text)} characters, the limit is {MAX_MESSAGE_TEXT}: write the content to a "
            "workspace file with write_session_file and send a short message naming the file"
        )
    if _direction(entry, member) == "receive":
        raise ValueError(
            f"channel {channel!r} only carries messages from {entry['from']!r} to you: you cannot send on it. "
            "Use another of your channels (call list_channels) or write your result to a workspace file"
        )
    to = _other(entry, member)
    queue_id = _queue_id(team, channel, member)
    with QUEUE_LOCKS_GUARD:
        lock = QUEUE_LOCKS.setdefault(queue_id, threading.Lock())
    with lock:
        messages = _queue(team, channel, member)
        seq = max((message["seq"] for message in messages), default=0) + 1
        messages.append({"seq": seq, "text": text, "sent": _now()})
        stored = {"channel": channel, "from": member, "to": to, "messages": messages}
        blobstore.put(queue_id, json.dumps(stored), "tool-gateway", info.get("trace_id", ""))
    return {"channel": channel, "seq": seq, "to": to}


def read_messages(team: str, member: str, channel: str, after: int = 0) -> dict:
    """Re-read the messages of one of your team channels, both directions, oldest first.

    New messages are given to you automatically at the start of a turn, so use
    this only to look up what was said earlier. team is the team path and
    member is your own member name, both given in your instructions. channel is
    a channel ID from list_channels, for example "coder--lead". after=0 returns
    every message; after=5 skips the first 5 messages of the channel.
    Example: read_messages(team="teams/t1/build", member="coder", channel="coder--lead").
    Returns {"channel", "messages": [{"from", "text", "sent"}]}: from is the
    sender's member name and sent is the UTC time.
    Fails with a message when the channel is not one of yours; call
    list_channels to see your channels.
    """
    info = _team(team)
    _team_member(info, member)
    entry = _team_channel(info, member, channel)
    # The channel is its two queues, one per sender, merged into one history by send time.
    history = [
        {"from": sender, "text": message["text"], "sent": message["sent"]}
        for sender in entry["members"]
        for message in _queue(team, channel, sender)
    ]
    history.sort(key=lambda message: _sent(message["sent"]))
    return {"channel": channel, "messages": history[max(after, 0) :]}


def finish_team(team: str, member: str, files: list[str], summary: str) -> str:
    """Finish the team's work and name the workspace files that are its result. Only the lead may call this.

    team is the team path and member is your own member name, both given in
    your instructions. files is the list of workspace file names that are the
    result, for example ["main.py", "test_main.py"]; it must not be empty and
    every file must already exist in the workspace (check with
    list_session_files, passing the team path as session). summary is a short
    text saying what was built.
    Example: finish_team(team="teams/t1/build", member="lead",
    files=["main.py", "test_main.py"], summary="Calculator with unit tests.").
    Call it once, when all work is done and reviewed; the team stops after it.
    Returns a confirmation. Fails with a message when you are not the lead or
    when a file is missing.
    """
    info = _team(team)
    _team_member(info, member)
    if member != info.get("lead"):
        raise ValueError(
            f"only the lead {info.get('lead')!r} can finish the team: send your result to the lead "
            "with send_message instead"
        )
    if not isinstance(files, list) or not files or not all(isinstance(name, str) for name in files):
        raise ValueError('files is empty: pass the names of the result files, for example ["main.py"]')
    for name in files:
        _team_file(team, name)
    existing = sorted(entry["name"] for entry in _session_files(team))
    missing = [name for name in files if name not in existing]
    if missing:
        raise ValueError(
            f"these files do not exist in the workspace: {missing}. Existing files: {existing}. "
            "Write them with write_session_file or correct the names, then call finish_team again"
        )
    finished = {"summary": summary, "files": files, "finished_at": _now()}
    blobstore.put(f"{team}/finished.json", json.dumps(finished), "tool-gateway", info.get("trace_id", ""))
    return f"Team finished. Result files: {', '.join(files)}."


def _now() -> str:
    """Return the UTC time as RFC 3339 with microseconds, so messages of two queues order by it."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _sent(value: str) -> datetime:
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return datetime.min.replace(tzinfo=timezone.utc)


def _is_team(path: str) -> bool:
    return path.startswith(TEAM_ROOT + "/")


def _team_path(team: str) -> str:
    segments = team.split("/")
    if len(segments) < 3 or segments[0] != TEAM_ROOT or "\n" in team or not valid_id(team):
        raise ValueError(
            f"invalid team {team!r}: use the team path given in your instructions, "
            f'such as "{TEAM_ROOT}/<trace-id>/<step-id>"'
        )
    return team


def _team_file(team: str, name: str) -> str:
    if not TEAM_FILE_NAME.fullmatch(name):
        raise ValueError(
            f"invalid file name {name!r}: use letters, digits, '.', '_' and '-', start with a letter or "
            "digit, and end in .md, .txt, .json or a code extension such as .py, .go, .js, .ts, .html or .yaml"
        )
    return f"{_team_path(team)}/files/{name}"


def _team(team: str) -> dict[str, Any]:
    try:
        return json.loads(blobstore.get(f"{_team_path(team)}/team.json"))
    except NotFoundError:
        raise ValueError(
            f"team {team!r} does not exist: use the team path given in your instructions unchanged"
        ) from None


def _team_member(info: dict[str, Any], member: str) -> None:
    names = [entry["name"] for entry in info.get("members", [])]
    if member not in names:
        raise ValueError(
            f"{member!r} is not a member of this team: pass your own member name as member. Members: {names}"
        )


def _team_channel(info: dict[str, Any], member: str, channel: str) -> dict[str, Any]:
    own = [entry for entry in info.get("channels", []) if member in entry["members"]]
    for entry in own:
        if entry["id"] == channel:
            return entry
    raise ValueError(
        f"{channel!r} is not a channel of {member!r}: use one of {[entry['id'] for entry in own]} "
        "(call list_channels to see who is on each)"
    )


def _direction(channel: dict[str, Any], member: str) -> str:
    """Return "both", or "send" or "receive" for a one-way channel, as seen by member."""
    sender = channel.get("from", "")
    if not sender:
        return "both"
    return "send" if sender == member else "receive"


def _other(channel: dict[str, Any], member: str) -> str:
    return next((name for name in channel["members"] if name != member), member)


def _queue_id(team: str, channel: str, sender: str) -> str:
    return f"{team}/channels/{channel}/{sender}.json"


def _queue(team: str, channel: str, sender: str) -> list[dict[str, Any]]:
    """Return the messages sender sent on the channel; none when sender sent nothing yet."""
    try:
        return json.loads(blobstore.get(_queue_id(team, channel, sender))).get("messages") or []
    except NotFoundError:
        return []


def _read_markers(team: str, member: str) -> dict[str, int]:
    try:
        return json.loads(blobstore.get(f"{team}/members/{member}.json")).get("read") or {}
    except NotFoundError:
        return {}


def _session(session: str) -> str:
    if _is_team(session):
        return _team_path(session)
    segments = session.split("/")
    # valid_id anchors with "$", which also matches before a trailing newline in a segment.
    if len(segments) < 3 or segments[0] != SESSION_ROOT or "\n" in session or not valid_id(session):
        raise ValueError(
            f"invalid session {session!r}: use the session path given in your instructions, "
            f'such as "{SESSION_ROOT}/<trace-id>/<step-id>"'
        )
    return session


def _session_file(session: str, name: str) -> str:
    if _is_team(session):
        return _team_file(session, name)
    if not SESSION_FILE_NAME.fullmatch(name):
        raise ValueError(
            f"invalid file name {name!r}: use letters, digits, '.', '_' and '-', "
            "start with a letter or digit, and end in .md, .txt or .json"
        )
    return f"{_session(session)}/files/{name}"


def _session_files(session: str) -> list[dict[str, Any]]:
    try:
        listing = blobstore.list(f"{_session(session)}/files")
    except NotFoundError:
        return []
    files = [{"name": entry["id"].rsplit("/", 1)[-1], "size": entry.get("size")} for entry in listing["objects"]]
    pattern = TEAM_FILE_NAME if _is_team(session) else SESSION_FILE_NAME
    return [entry for entry in files if pattern.match(entry["name"])]


def _sentences(text: str) -> list[str]:
    return [s.strip() for line in text.splitlines() for s in SENTENCE_END.split(line) if s.strip()]


def _assess(text: str) -> dict[str, Any]:
    sentences = _sentences(text)
    words = len(WORD.findall(text))
    requirements = sum(1 for s in sentences if REQUIREMENT.search(s))
    components = {w for s in sentences for w in WORD.findall(s)[1:] if CAPITALIZED.match(w)}
    reasons = []
    if words > 200:
        reasons.append(f"more than 200 words ({words})")
    if words > 800:
        reasons.append(f"more than 800 words ({words})")
    if requirements >= 5:
        reasons.append(f"5 or more requirements ({requirements})")
    if len(components) >= 10:
        reasons.append(f"10 or more components mentioned ({len(components)})")
    score = 1 + len(reasons)
    if not reasons:
        reasons.append("short text with few requirements and components")
    return {
        "words": words,
        "sentences": len(sentences),
        "requirements": requirements,
        "components": len(components),
        "score": score,
        "reasons": reasons,
    }
