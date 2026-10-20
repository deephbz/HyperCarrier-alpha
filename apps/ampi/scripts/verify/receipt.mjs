// The tested commit in a verify receipt: the hash the runner was asked to check, the hash the hub doctor read, and why
// a run fails when it cannot prove they are the same commit.

const HASH = /^[0-9a-f]{40}$/;

/** `{ requested, actual, failure }`, where `failure` is null only when both are full hashes of one commit. */
export function commitRecord({ requested, actual }) {
  const req = HASH.test(requested ?? '') ? requested : null;
  const act = HASH.test(actual ?? '') ? actual : null;
  const failure = !req ? `could not read the requested commit (${requested ?? 'none'})`
    : !act ? `could not read the tested commit from the hub doctor (${actual ?? 'none'})`
    : act !== req ? `tested commit ${act.slice(0, 12)} is not the requested ${req.slice(0, 12)}`
    : null;
  return { requested: req, actual: act, failure };
}

/** The commit record of a written receipt; a receipt without `requested` and `actual` fails as unreadable. */
export function receiptCommit(receipt) {
  return commitRecord({ requested: receipt?.requested, actual: receipt?.actual });
}
