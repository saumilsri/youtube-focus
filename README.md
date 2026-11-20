# YouTube Focus

A Chrome extension (Manifest V3) that turns the YouTube home page into a short, deliberate list instead of an endless feed. No API key, nothing sent anywhere: it only reads the recommendations YouTube already loads.

## Why

I quit doomscrolling Instagram and TikTok, but I still like YouTube. Longer videos are often genuinely informative. I use it in two ways:

1. **Learning something specific** (for work or otherwise). Search handles this fine: I look it up, or get sent a link.
2. **Browsing to discover interesting things.** This is where it goes wrong.

There are extensions that blank out the YouTube feed entirely, so you only see what you search for. I like that idea, but it throws away discovery. The real problem with the normal feed isn't that recommendations exist. It's that there are *too many good ones*. I'd scroll, keep adding videos to Watch later, and keep browsing. That's doomscrolling through a loophole: always thinking "I could watch this" instead of watching what's in front of me.

YouTube Focus keeps the search bar and adds just **3 recommendations** under it. They stay the same for 2 hours, even if you refresh. Those are the only videos on offer until the timer runs out, so the choice is small and you actually watch something. The shelf gives a few videos a place to wait for later in the day, without piling up an endless Watch later list.

## What it does

**Home page**
- Hides the recommendation feed and shows **3 picks** taken from YouTube's own recommendations, in YouTube's order.
- Filters out Shorts, live streams, lectures (keywords like *Lecture*, *Lec 3*, *Full Course*, *Week 4*, *Midterm*, course codes like *CS 101*) and long background music (an hour or longer with words like *music*, *instrumental*, *lofi*).
- Mostly serious videos; at most 1 fun one, and only when YouTube ranks it high. Unknown videos count as serious.
- Picks are **locked for 2 hours**, even across refreshes and browser restarts, with a countdown to the next batch.
- Each pick has **+ Add to shelf**, **Skip channel** (hide the channel from future picks) and **Wrong type** (flip the channel between serious and fun). The ⋮ menu saves to YouTube's Watch later.
- Hovering a thumbnail plays YouTube's own short, silent animated preview.

**Shelf**
- The extension's own watch-later list, shown above the picks. Holds up to 5 videos.
- A video stays until you remove it or watch it to the end. Shelf videos are never picked again.

**Everywhere else**
- Shorts hidden (shelves, tabs, sidebar link).
- Watch page sidebar trimmed to the first 5 videos.
- Autoplay turned off.
- The menu button is hidden and the logo becomes a **YouTube Focus** wordmark that reloads home.

**Options**
- Hover the YouTube Focus wordmark for 5 seconds; a ring traces around it and a ⚙ gear rolls out. That is the only way in, on purpose.
- Edit lock time, batch size, max fun videos, all keyword lists, the long-music rule, skipped channels and channel types. There is also a title tester.

Follows YouTube's light or dark theme.

## Install

1. Open `chrome://extensions` (or `comet://extensions` in Comet).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick this folder.
4. Refresh any open YouTube tabs.

After pulling changes, click the reload arrow on the extension's card, then refresh YouTube.

If the gear ever becomes unreachable, open the extension's **Details** to find its ID and visit `chrome-extension://<ID>/options.html`.

## Testing the 2-hour lock without waiting

- In options, set **Lock time** to `1` minute and save; the countdown drops below a minute and a new batch appears when it ends.
- Or keep 120 minutes and run this in the options page's DevTools console to make the current batch look 2 hours old:

  ```js
  chrome.storage.local.get('lock', ({lock}) => { lock.pickedAt -= 2*60*60*1000; chrome.storage.local.set({lock}); })
  ```

## Files

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest |
| `main.js` | Runs in the page's own context to read YouTube's feed data and run its Watch later command |
| `content.js` / `content.css` | Home panel, shelf, hiding rules, autoplay, top-bar wordmark |
| `shared.js` | Picking, filtering and lock logic (shared with options and tests) |
| `options.html` / `options.js` / `options.css` | Options page |
| `background.js` | Opens the options page when the gear is clicked |
| `tests/logic.test.js` | Unit tests |

## Tests

```bash
node --test tests/logic.test.js
```

## License

[MIT](LICENSE). Free to use, change and share.
