"""Remove console trailers from moz-phab's outgoing commit text."""

import copy
import functools
import json
import os
import re
import sys


INTERNAL_TRAILER = re.compile(
    r"^(?:TB-Tools-Id|Tb-Implement-Step|Tb-Try-Monitor|Tb-Try-Repair):[^\r\n]*(?:\r?\n|$)",
    re.IGNORECASE | re.MULTILINE,
)


def strip_internal_trailers(message):
    return INTERNAL_TRAILER.sub("", message).rstrip()


def filter_request(method, args):
    if method == "differential.revision.edit":
        result = copy.deepcopy(args)
        for transaction in result.get("transactions", []):
            if transaction.get("type") == "summary":
                transaction["value"] = strip_internal_trailers(transaction["value"])
        return result
    if method == "differential.setdiffproperty" and args.get("name") == "local:commits":
        result = copy.deepcopy(args)
        commits = json.loads(result["data"])
        for commit in commits.values():
            if "message" in commit:
                commit["message"] = strip_internal_trailers(commit["message"])
        result["data"] = json.dumps(commits)
        return result
    if method == "differential.parsecommitmessage" and "corpus" in args:
        return {**args, "corpus": strip_internal_trailers(args["corpus"])}
    return args


def install_filter():
    from mozphab.conduit import ConduitAPI

    original = ConduitAPI._build_request

    @functools.wraps(original)
    def build_request(self, *, method, args, token):
        return original(self, method=method, args=filter_request(method, args), token=token)

    ConduitAPI._build_request = build_request


if os.environ.get("TB_TOOLS_MOZPHAB_SUBMIT") == "1":
    try:
        install_filter()
    except Exception:
        sys.stderr.write("Cannot install the moz-phab message filter. Submission stopped.\n")
        sys.stderr.flush()
        os._exit(1)
