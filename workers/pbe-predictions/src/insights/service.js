// Builds stories from their evidence packets (cached per isolate; the packets are as-of bounded, so a cached build
// can only miss a later resolution update, which the 10-minute TTL picks up).
import { STORIES, storyBySlug } from './stories.js';
import { loadEventPacket } from './packet.js';

const cache = new Map();
const TTL = 10 * 60 * 1000;

export const isPublished = (story, now = Date.now()) => now >= Date.parse(story.published_at);

export async function buildStory(store, story) {
  const hit = cache.get(story.slug);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  const packets = {};
  await Promise.all(story.events.map(async (slug) => { packets[slug] = await loadEventPacket(store, slug, story.as_of); }));
  const built = story.build(packets);
  const value = built.ok ? { story, built, words: countWords(built) } : null;
  if (!built.ok) console.log(JSON.stringify({ insights: 'story_unavailable', slug: story.slug, reason: built.reason }));
  cache.set(story.slug, { at: Date.now(), value });
  return value;
}

export async function publishedStories(store, now = Date.now()) {
  const out = await Promise.all(STORIES.filter((s) => isPublished(s, now)).map((s) => buildStory(store, s)));
  return out.filter(Boolean).sort((a, b) => b.story.published_at.localeCompare(a.story.published_at) || STORIES.indexOf(a.story) - STORIES.indexOf(b.story));
}

export async function storyForSlug(store, slug, now = Date.now()) {
  const s = storyBySlug(slug);
  return s && isPublished(s, now) ? buildStory(store, s) : null;
}

export const storiesForEvent = (slug, now = Date.now()) => STORIES.filter((s) => isPublished(s, now) && s.events.includes(slug));

function countWords(built) {
  const text = `${built.quick.join(' ')} ${built.sections}`.replace(/<figure[\s\S]*?<\/figure>/g, ' ').replace(/<[^>]+>/g, ' ');
  return text.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
}
