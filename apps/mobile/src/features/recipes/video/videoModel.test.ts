import { catalogue } from '@cookmate/catalogue';
import { buildEmbedUrl, classifyPlayerError, safeSourceUrl, youtubeVideoId } from './videoModel';

test.each([
  'https://www.youtube.com/watch?v=SC17Mc70Db0&t=12',
  'http://youtube.com/watch?v=SC17Mc70Db0',
  'https://m.youtube.com/watch?v=SC17Mc70Db0',
  'https://youtu.be/SC17Mc70Db0?si=anything',
  'https://www.youtube.com/embed/SC17Mc70Db0',
  'https://www.youtube.com/shorts/SC17Mc70Db0',
])('canonicalizes the supplied YouTube identity: %s', (url) => {
  expect(youtubeVideoId(url)).toBe('SC17Mc70Db0');
});
test.each([
  'https://youtube.com.evil.test/watch?v=SC17Mc70Db0',
  'https://youtube.com@evil.test/watch?v=SC17Mc70Db0',
  'https://evil.test/youtube.com/watch?v=SC17Mc70Db0',
  'javascript:alert(1)',
  'data:text/html,test',
  '//youtube.com/watch?v=SC17Mc70Db0',
  'https://youtu.be/SC17Mc70Db0/extra',
  'https://youtube.com:444/watch?v=SC17Mc70Db0',
  'https://youtube.com/watch?v=SC17Mc70Db0&v=AAAAAAAAAAA',
  'https://youtube.com/watch?v=%3Cscript%3E',
  'https://youtube.com/watch?v=short',
])('does not embed malformed or deceptive input: %s', (url) =>
  expect(youtubeVideoId(url)).toBeNull(),
);
test('all existing YouTube recipe links retain their exact identity', () => {
  const supplied = catalogue.recipes.filter((recipe) => recipe.videoUrl);
  expect(supplied.length).toBeGreaterThan(0);
  for (const recipe of supplied) {
    const source = new URL(recipe.videoUrl!);
    if (source.hostname.endsWith('youtube.com') || source.hostname === 'youtu.be') {
      expect(youtubeVideoId(recipe.videoUrl)).toMatch(/^[\w-]{11}$/);
    }
  }
});
test('constructs a controlled HTTPS embed with the real containing origin', () => {
  const url = new URL(buildEmbedUrl('SC17Mc70Db0', 'http://localhost:8081'));
  expect(url.origin).toBe('https://www.youtube.com');
  expect(url.pathname).toBe('/embed/SC17Mc70Db0');
  expect(Object.fromEntries(url.searchParams)).toEqual({
    playsinline: '1',
    enablejsapi: '1',
    controls: '1',
    origin: 'http://localhost:8081',
  });
  expect(() => buildEmbedUrl('bad', 'https://dev.cookmate.prototype')).toThrow();
  expect(() => buildEmbedUrl('SC17Mc70Db0', 'https://valid.test/path')).toThrow();
  expect(() => buildEmbedUrl('SC17Mc70Db0', 'file:///tmp')).toThrow();
});
test('external fallback accepts only safe web URLs', () => {
  expect(safeSourceUrl('https://publisher.test/video')?.hostname).toBe('publisher.test');
  expect(safeSourceUrl('https://user:password@publisher.test/video')).toBeNull();
  expect(safeSourceUrl('https://publisher.test/\nvideo')).toBeNull();
  expect(safeSourceUrl(null)).toBeNull();
});
test('separates identity failures from removed or blocked video errors', () => {
  expect(classifyPlayerError(153)).toBe('configuration');
  for (const code of [100, 101, 150]) expect(classifyPlayerError(code)).toBe('unavailable');
  expect(classifyPlayerError(5)).toBe('playback');
});
