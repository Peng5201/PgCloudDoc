/**
 * 极简 semver 范围判断。
 *
 * 只实现 manifest `engines.pgclouddoc` 实际会用的子集：
 *   1.2.3 / =1.2.3 / >1.2.3 / >=1.2.3 / <2.0.0 / <=2.0.0 / ^1.4.0 / ~1.4.0
 *   空格表示 AND，`||` 表示 OR，`*` 表示任意。
 *
 * 不引入 semver 包：宿主和插件都不该为一个范围字符串多一个运行时依赖。
 * 解析失败一律返回 false（宁可禁用插件，也不要误放行）。
 */

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

const VERSION_RE = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseVersion(input: string): ParsedVersion | null {
  const match = VERSION_RE.exec(input.trim());
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2] ?? 0);
  const patch = Number(match[3] ?? 0);
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  return { major, minor, patch, prerelease: match[4] ?? null };
}

function formatVersion(v: ParsedVersion): string {
  return `${v.major}.${v.minor}.${v.patch}${v.prerelease ? `-${v.prerelease}` : ''}`;
}

function comparePrerelease(a: string | null, b: string | null): number {
  if (a === b) return 0;
  // 没有 prerelease 的版本更高：1.0.0 > 1.0.0-beta
  if (a === null) return 1;
  if (b === null) return -1;

  const left = a.split('.');
  const right = b.split('.');
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const l = left[i];
    const r = right[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const ln = /^\d+$/.test(l) ? Number(l) : null;
    const rn = /^\d+$/.test(r) ? Number(r) : null;
    if (ln !== null && rn !== null) {
      if (ln !== rn) return ln < rn ? -1 : 1;
    } else if (l !== r) {
      return l < r ? -1 : 1;
    }
  }
  return 0;
}

export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return Number.NaN;

  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

function matchesComparator(version: ParsedVersion, comparator: string): boolean {
  const match = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(comparator.trim());
  if (!match) return false;

  const op = match[1] ?? '=';
  const target = parseVersion(match[2]);
  if (!target) return false;

  const current = formatVersion(version);
  const base = formatVersion(target);

  switch (op) {
    case '=':
      return compareVersions(current, base) === 0;
    case '>':
      return compareVersions(current, base) > 0;
    case '>=':
      return compareVersions(current, base) >= 0;
    case '<':
      return compareVersions(current, base) < 0;
    case '<=':
      return compareVersions(current, base) <= 0;
    case '^': {
      let upper: ParsedVersion;
      if (target.major > 0) {
        upper = { major: target.major + 1, minor: 0, patch: 0, prerelease: null };
      } else if (target.minor > 0) {
        upper = { major: 0, minor: target.minor + 1, patch: 0, prerelease: null };
      } else {
        upper = { major: 0, minor: 0, patch: target.patch + 1, prerelease: null };
      }
      return (
        compareVersions(current, base) >= 0 &&
        compareVersions(current, formatVersion(upper)) < 0
      );
    }
    case '~': {
      const upper: ParsedVersion = {
        major: target.major,
        minor: target.minor + 1,
        patch: 0,
        prerelease: null,
      };
      return (
        compareVersions(current, base) >= 0 &&
        compareVersions(current, formatVersion(upper)) < 0
      );
    }
    default:
      return false;
  }
}

/** 判断 version 是否落在 range 内；range 非法或 version 非法都返回 false */
export function satisfiesVersionRange(version: string, range: string): boolean {
  const parsed = parseVersion(version);
  if (!parsed) return false;

  const trimmed = range.trim();
  if (!trimmed || trimmed === '*') return true;

  return trimmed.split('||').some((group) => {
    const comparators = group.trim().split(/\s+/).filter(Boolean);
    if (comparators.length === 0) return true;
    return comparators.every((comparator) => matchesComparator(parsed, comparator));
  });
}
