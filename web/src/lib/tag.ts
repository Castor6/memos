import type { CSSProperties } from "react";
import { colorToHex } from "@/lib/color";
import type { UserSetting_TagMetadata, UserSetting_TagsSetting } from "@/types/proto/api/v1/user_service_pb";

/** Shared custom tag colors for memo cards, editors and filters. */
export const getTagStyle = (metadata?: UserSetting_TagMetadata): CSSProperties | undefined => {
  const color = colorToHex(metadata?.backgroundColor);
  return color
    ? {
        borderColor: color,
        color: `color-mix(in srgb, ${color} 60%, black)`,
        backgroundColor: `color-mix(in srgb, ${color} 15%, transparent)`,
      }
    : undefined;
};

// Cache compiled regexes to avoid re-compiling on every tag render.
const compiledPatternCache = new Map<string, RegExp | null>();

const getCompiledPattern = (pattern: string): RegExp | null => {
  if (compiledPatternCache.has(pattern)) {
    return compiledPatternCache.get(pattern)!;
  }
  let re: RegExp | null = null;
  try {
    re = new RegExp(`^(?:${pattern})$`);
  } catch {
    // Invalid pattern — cache as null so we skip it without retrying.
  }
  compiledPatternCache.set(pattern, re);
  return re;
};

/**
 * Finds the first matching TagMetadata for a given tag name by treating each
 * key in tagsSetting.tags as an anchored regex pattern (^pattern$).
 *
 * Lookup order:
 * 1. Exact key match (O(1) fast path, backward-compatible).
 * 2. Iterate all keys and test as anchored regex — first match wins.
 */
export const findTagMetadata = <M = UserSetting_TagMetadata>(tag: string, tagsSetting: { tags: Record<string, M> }): M | undefined => {
  // Fast path: exact match.
  if (tagsSetting.tags[tag]) {
    return tagsSetting.tags[tag];
  }

  // Regex path: treat each key as an anchored pattern.
  for (const [pattern, metadata] of Object.entries(tagsSetting.tags)) {
    const re = getCompiledPattern(pattern);
    if (re?.test(tag)) {
      return metadata;
    }
  }

  return undefined;
};

/**
 * Returns true if the given string is a valid, ReDoS-safe JavaScript regex pattern.
 *
 * Rejects patterns with nested quantifiers (e.g. `(a+)+`) which can cause
 * catastrophic backtracking in JavaScript's regex engine.
 */
export const isValidTagPattern = (pattern: string): boolean => {
  if (!pattern) return false;
  try {
    new RegExp(pattern);
  } catch {
    return false;
  }
  // Reject nested quantifiers: a quantified group whose body itself contains
  // a quantifier — the classic ReDoS shape e.g. (a+)+, (a*b?)+, (x|y+)+.
  if (/\((?:[^()]*[*+?{][^()]*)\)[*+?{]/.test(pattern)) {
    return false;
  }
  return true;
};

interface ImageGridRule {
  imageGrid?: boolean;
}

/** Effective image grid state of a tag; `source` is the ancestor tag it is inherited from. */
export interface TagImageGrid {
  enabled: boolean;
  source?: string;
}

const parentTag = (tag: string): string | undefined => {
  const index = tag.lastIndexOf("/");
  return index > 0 ? tag.slice(0, index) : undefined;
};

/**
 * Resolves the image grid state of a tag. A rule without an explicit value follows the
 * parent tag, so the lookup walks up `a/b/c` → `a/b` → `a` until a rule sets the value.
 */
export const resolveTagImageGrid = (tag: string, tagsSetting: { tags: Record<string, ImageGridRule> }): TagImageGrid => {
  for (let level: string | undefined = tag; level; level = parentTag(level)) {
    const imageGrid = findTagMetadata(level, tagsSetting)?.imageGrid;
    if (imageGrid !== undefined) {
      return level === tag ? { enabled: imageGrid } : { enabled: imageGrid, source: level };
    }
  }
  return { enabled: false };
};

/** Whether any of the memo's tags shows images as a grid below the content. */
export const hasImageGridTag = (tags: readonly string[] | undefined, tagsSetting: UserSetting_TagsSetting | undefined): boolean =>
  Boolean(tagsSetting && tags?.some((tag) => resolveTagImageGrid(tag, tagsSetting).enabled));

/**
 * Sets the image grid state of a tag and makes all descendant rules follow it again.
 * When the value equals the parent's, the tag's own value is cleared so it keeps following
 * the parent. `isEmpty` lets callers drop exact rules left without any setting, unless a
 * pattern rule would then take over the tag.
 */
export const applyImageGridToggle = <M extends ImageGridRule>(
  tags: Record<string, M>,
  tag: string,
  enabled: boolean,
  options: { create: (inherited?: M) => M; isEmpty?: (rule: M) => boolean },
): Record<string, M> => {
  const next = { ...tags };
  const parent = parentTag(tag);
  const inherited = parent ? resolveTagImageGrid(parent, { tags: next }).enabled : false;
  const base = next[tag] ?? options.create(findTagMetadata(tag, { tags: next }));
  next[tag] = { ...base, imageGrid: enabled === inherited ? undefined : enabled };

  for (const name of Object.keys(next)) {
    if (name.startsWith(`${tag}/`) && next[name].imageGrid !== undefined) {
      next[name] = { ...next[name], imageGrid: undefined };
    }
  }

  if (options.isEmpty) {
    for (const name of [tag, ...Object.keys(next).filter((name) => name.startsWith(`${tag}/`))]) {
      if (!next[name] || !options.isEmpty(next[name])) continue;
      const { [name]: _removed, ...rest } = next;
      // Keep the empty exact rule when removing it would let a pattern rule apply instead.
      if (findTagMetadata(name, { tags: rest }) === undefined) {
        delete next[name];
      }
    }
  }
  return next;
};
