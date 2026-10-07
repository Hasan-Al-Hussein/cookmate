import { CUISINE_ALIASES, normalizeSearchText, SEARCH_QUERY_MAX_LENGTH } from '@cookmate/domain';
import type { ContentFavouriteEntry } from '../../data/contentWorkspaceQueries';

export function favouriteTitle(entry: ContentFavouriteEntry) {
  return entry.content.kind === 'readable'
    ? entry.content.title
    : `Recipe ${entry.favourite.recipeId}`;
}

/** Search the verified saved projection, including archived recipes; never the bundled catalogue. */
export function contentFavouritesList(
  entries: readonly ContentFavouriteEntry[],
  order: 'recent' | 'alphabetical',
  query: string,
) {
  if (query.length > SEARCH_QUERY_MAX_LENGTH) throw new Error('Search is too long');
  const tokens = normalizeSearchText(query).split(' ').filter(Boolean);
  return [...entries]
    .sort(
      (a, b) =>
        (order === 'recent'
          ? b.favourite.savedAt.localeCompare(a.favourite.savedAt)
          : favouriteTitle(a).localeCompare(favouriteTitle(b))) ||
        a.favourite.recipeId.localeCompare(b.favourite.recipeId),
    )
    .filter((entry) => {
      if (!tokens.length) return true;
      if (entry.content.kind !== 'readable')
        return tokens.every((token) => entry.favourite.recipeId.includes(token));
      const content = entry.content;
      const title = normalizeSearchText(content.title);
      const fields = [
        content.cuisine,
        content.category,
        ...content.ingredientNames,
        ...(CUISINE_ALIASES[normalizeSearchText(content.cuisine)] ?? []),
      ].map(normalizeSearchText);
      return tokens.every(
        (token) =>
          (token.length < 2 ? title.split(' ').includes(token) : title.includes(token)) ||
          fields.some((field) =>
            field
              .split(' ')
              .some((word) => (token.length < 2 ? word === token : word.startsWith(token))),
          ),
      );
    });
}
