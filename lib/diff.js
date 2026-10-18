'use strict';
// Minimal line diff (LCS) for showing file edits in the approval dialog.
// Returns [{op:' '|'+'|'-', line}] trimmed to context around changes.

const MAX_LINES = 4000;

function lineDiff(a, b, context = 3) {
  const A = String(a ?? '').split('\n');
  const B = String(b ?? '').split('\n');
  if (A.length > MAX_LINES || B.length > MAX_LINES) {
    return [{ op: '!', line: `(ไฟล์ใหญ่เกินไปที่จะแสดง diff: ${A.length} → ${B.length} บรรทัด)` }];
  }
  // Strip common prefix/suffix to keep the LCS table small.
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const a2 = A.slice(pre, A.length - suf);
  const b2 = B.slice(pre, B.length - suf);
  const n = a2.length;
  const m = b2.length;
  const ops = [];
  if (n * m > 4_000_000) {
    a2.forEach((l) => ops.push({ op: '-', line: l }));
    b2.forEach((l) => ops.push({ op: '+', line: l }));
  } else {
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        dp[i][j] = a2[i] === b2[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a2[i] === b2[j]) { ops.push({ op: ' ', line: a2[i] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push({ op: '-', line: a2[i++] });
      else ops.push({ op: '+', line: b2[j++] });
    }
    while (i < n) ops.push({ op: '-', line: a2[i++] });
    while (j < m) ops.push({ op: '+', line: b2[j++] });
  }
  const full = [
    ...A.slice(Math.max(0, pre - context), pre).map((l) => ({ op: ' ', line: l })),
    ...ops,
    ...A.slice(A.length - suf, A.length - suf + context).map((l) => ({ op: ' ', line: l })),
  ];
  return full;
}

module.exports = { lineDiff };
