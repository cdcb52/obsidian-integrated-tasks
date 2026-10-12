import type { NavOrder, TaskManagerSettings } from "./types";

/** `keys` with `key` moved to just before (or after) `target`; unchanged when `target` is not among them. */
export function moveKey(keys: string[], key: string, target: string, after: boolean): string[] {
  if (key === target || !keys.includes(target)) return keys;
  const rest = keys.filter(item => item !== key);
  rest.splice(rest.indexOf(target) + (after ? 1 : 0), 0, key);
  return rest;
}

/** `items` in the order `keys` lists them; the rest follow as they were. */
export function inOrder<T>(items: readonly T[], keys: string[], key: (item: T) => string): T[] {
  if (!keys.length) return [...items];
  const position = new Map(keys.map((item, index) => [item, index]));
  const at = (item: T): number => position.get(key(item)) ?? keys.length;
  // A stable sort: what is not listed keeps its order, after what is.
  return [...items].sort((a, b) => at(a) - at(b));
}

const strings = (value: unknown): string[] => Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string"))] : [];

/** A saved sidebar order, keeping only what is one. */
export function navOrderFrom(value: unknown): NavOrder {
  const saved = value && typeof value === "object" ? value as Partial<Record<keyof NavOrder, unknown>> : {};
  const files = saved.files && typeof saved.files === "object" && !Array.isArray(saved.files) ? saved.files as Record<string, unknown> : {};
  return {
    projects: strings(saved.projects),
    tags: strings(saved.tags),
    files: Object.fromEntries(Object.entries(files).map(([folder, names]): [string, string[]] => [folder, strings(names)]).filter(([, names]) => names.length > 0))
  };
}

/** The folder `path` is in, as the file tree keys its orders: "/" for the vault's top. */
export function folderOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "/" : path.slice(0, slash);
}

const nameOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
/** Favorites that name a note or folder by its path. */
const PATH_FAVORITE = /^(file|folder|project):(.+)$/;

type SidebarPaths = Pick<TaskManagerSettings, "favorites" | "navOrder">;

/**
 * The favorites and orders after a note or folder moves from `oldPath` to `path`: what names it (or, for a folder,
 * something in it) follows, and so does its place in its folder's order when only its name changed. Moved to another
 * folder, it leaves its old folder's order, unless that folder is gone too (`folderExists`), renamed along with it.
 * Undefined when nothing names it.
 */
export function renameSidebarPaths(settings: SidebarPaths, oldPath: string, path: string, folder: boolean, folderExists: (path: string) => boolean): SidebarPaths | undefined {
  const moved = (item: string): string | undefined =>
    item === oldPath ? path : folder && item.startsWith(`${oldPath}/`) ? path + item.slice(oldPath.length) : undefined;
  let changed = false;
  const follow = (item: string): string => {
    const target = moved(item);
    if (target === undefined) return item;
    changed = true;
    return target;
  };
  const favorites = settings.favorites.map(key => {
    const match = PATH_FAVORITE.exec(key);
    return match ? `${match[1]}:${follow(match[2])}` : key;
  });
  const projects = settings.navOrder.projects.map(follow);
  const files: Record<string, string[]> = {};
  for (const [key, names] of Object.entries(settings.navOrder.files)) files[follow(key)] = names;
  const [from, to] = [folderOf(oldPath), folderOf(path)];
  const names = files[from];
  if (names?.includes(nameOf(oldPath))) {
    if (from === to) files[from] = names.map(name => name === nameOf(oldPath) ? nameOf(path) : name);
    else if (folderExists(from)) files[from] = names.filter(name => name !== nameOf(oldPath));
    changed = true;
  }
  return changed ? { favorites, navOrder: { ...settings.navOrder, projects, files } } : undefined;
}

/** The favorites and orders without a deleted note or folder (and, for a folder, what was in it); undefined when nothing names it. */
export function forgetSidebarPaths(settings: SidebarPaths, path: string, folder: boolean): SidebarPaths | undefined {
  const gone = (item: string): boolean => item === path || (folder && item.startsWith(`${path}/`));
  const favorites = settings.favorites.filter(key => !gone(PATH_FAVORITE.exec(key)?.[2] ?? ""));
  const projects = settings.navOrder.projects.filter(item => !gone(item));
  const files = Object.fromEntries(Object.entries(settings.navOrder.files).filter(([key]) => !gone(key))
    .map(([key, names]) => [key, key === folderOf(path) ? names.filter(name => name !== nameOf(path)) : names]));
  const changed = favorites.length !== settings.favorites.length || projects.length !== settings.navOrder.projects.length ||
    JSON.stringify(files) !== JSON.stringify(settings.navOrder.files);
  return changed ? { favorites, navOrder: { ...settings.navOrder, projects, files } } : undefined;
}
