# Kingside

A small chess site where you can play a friend through an invite link or get matched with a random opponent. It has accounts, Elo ratings, game clocks, chat and a rematch button.

## Run it

You need Node.js 22.13 or newer (the current LTS from nodejs.org is fine). Run `node -v` to check.

```bash
npm install
npm start
```

Open http://localhost:3000. To try it alone, open the site in two browser tabs (each tab is its own guest), start a game in one and open the invite link in the other.

Environment variables:

| Variable  | Default        | Purpose                          |
|-----------|----------------|----------------------------------|
| `PORT`    | `3000`         | Port the server listens on       |
| `DB_PATH` | `./chess.db`   | Where the SQLite database is kept |

## How it plays

- **Invite a friend**: pick a time limit and colour, press "Invite a friend", and send the link. The game starts when they open it. Friend games are casual.
- **Random opponent**: pick a time limit and press "Play a random opponent". The first two people waiting on the same time limit are paired with random colours. The game is rated when both players are logged in.
- **Guests** can play everything except rated games. Guest names look like `Guest-1a2b`.
- **Clocks** run on the server, so they can't be cheated. They start once both players have made their first move. A game is aborted, with no rating change, if a side doesn't make its first move within 60 seconds. Resigning before both players have moved also counts as an abort.
- **Rules** (castling, en passant, promotion, check, checkmate, stalemate, insufficient material, threefold repetition, fifty-move rule) come from the `chess.js` library. The server checks every move.
- **Ratings** are separate for Bullet, Blitz and Rapid, so a game only changes the rating for its own category. Each starts at 1200 and uses Elo with K = 32. A game's category comes from its clock (the minutes plus 40 times the seconds added per move): under 3 minutes is Bullet (1+0), under 8 minutes is Blitz (3+0, 3+2, 5+0, 5+3), and 8 or more is Rapid (10+0, 15+10). Profiles show all three, and the top-players list has a tab for each. Where only one number fits (the top bar and search results), it is the rating for the category you have played most.
- **Upgrading from one rating per player.** The first time this version starts on an existing database, each player's old rating is split by replaying the rated games in the history: their rating in a category becomes 1200 plus the points they won or lost in that category. Nobody's total changes, and it only happens once.
- Anyone with a game link who isn't a player can watch the game but can't move or chat.
- Reloading the page or losing your connection puts you back in your seat.
- **Player search** is the box at the bottom left of every page: type two or more letters of a name, pick a result (arrow keys and Enter work), and you land on that player's profile.
- **Play** at the top right takes you back to the lobby from anywhere (it asks first if you are in the middle of a game).

## Profiles and titles

Every account has a public profile at `#/u/<username>` (click any registered player's name): a rating and record for each of Bullet, Blitz and Rapid, a short bio they can edit, and recent games.

Players can't give themselves a title, otherwise anyone could claim to be a "GM". You grant titles yourself from the folder where the site runs:

```bash
node set-title.js Alice GM       # give Alice a GM badge
node set-title.js Alice none     # remove it
```

Available titles: GM, IM, FM, CM, WGM, WIM, WFM, WCM, NM. The badge appears next to the name on the profile, in games, on the top-players list and in the top bar. It's safe to run while the server is on. Only hand out real titles to people whose FIDE title you've checked.

## Moderation

There are three kinds of player: the **owner** (you), **moderators**, and everyone else.

| | Owner | Moderator | Player |
|---|---|---|---|
| Ban and unban regular players | yes | yes | no |
| Ban moderators | yes | no | no |
| Lift a ban the owner set | yes | no | no |
| Make or remove moderators | yes | no | no |
| Can be banned | no | by the owner | yes |

**Becoming the owner.** Create your account on the site first, then run this in the folder where the site runs (on Render, use the service's Shell tab):

```bash
node set-role.js YourUsername owner
```

This is the only way to create an owner, so nobody can promote themselves from the website. You can also run `node set-role.js Bob mod` or `node set-role.js Bob none`.

**Giving someone ban powers.** Log in as the owner, open their profile (click their name anywhere) and press "Make moderator". "Remove moderator" takes it back.

**Banning.** Open a player's profile and use the moderation box: pick 1 hour, 1 day, 1 week, 30 days or permanent, give a reason, and press Ban. The player is signed out and disconnected straight away, any game they are in ends with their opponent winning by forfeit, and they can't log in until the ban ends. Banned players see the reason you wrote and are hidden from the top-players list. The **Moderation** button in the top bar lists current bans (with a Lift button) and a log of recent actions. Banning a moderator also removes their moderator powers.

**Limits.** Bans apply to accounts. A banned person can still play as a guest or make a new account. To make that harder, start the server with `ALLOW_GUESTS=0`, which asks everyone to log in before they can play. Bans can't stop someone determined who is willing to keep making new accounts.

## Piece artwork

The chess pieces are SVG images in `public/pieces/` (`wK.svg` is the white king, `bP.svg` the black pawn, and so on). They are the "cburnett" set drawn by Colin M.L. Burnett, taken from the `chessground` npm package, which is distributed under the GNU General Public License v3 or later. `public/pieces/CREDITS.txt` and `COPYING.txt` carry the credit and the licence text; please keep them with the images, including when you deploy. I'm not a lawyer, so if you plan to do more than run this for friends, read the licence or ask someone who can.

To use a different set, replace the 12 SVG files with your own, keeping the same names. Nothing else needs to change.

## Files

```
server.js        HTTP + WebSocket server: matchmaking, games, clocks, Elo, chat
db.js            SQLite storage: users, sessions, finished games
set-title.js     Command for giving a player a title badge
set-role.js      Command for making someone the owner or a moderator
public/          The website (index.html, style.css, app.js), no build step
public/pieces/   The 12 piece images, with credits and licence
```

The site name and colours are easy to change: the name is in `public/index.html` and the colours are the variables at the top of `public/style.css`.

## Deploying to Render

`render.yaml` is a ready-made blueprint for [Render](https://render.com). It runs the site on a paid instance that never sleeps, with a small persistent disk for the database.

1. Put this folder in a GitHub repository (don't upload `node_modules` or any `chess.db` files).
2. In Render, choose New, then Blueprint, pick the repository and apply it.
3. When the deploy finishes, Render shows your site's public address (something like `kingside.onrender.com`).
4. To use your own domain, buy one from any registrar, then open the service's Settings, find Custom Domains, add it, copy the DNS records Render shows into your registrar, and press Verify.

To give a player a title or make yourself owner on the hosted site, open the service's Shell tab in Render and run `node set-title.js Alice GM` or `node set-role.js YourUsername owner`.

## Putting it online (other hosts)

Any host that can run a Node.js server and keep a WebSocket open will work (Render, Fly.io, Railway, a VPS). Use `npm start` as the start command. Over HTTPS the browser automatically uses secure WebSockets.

Things to know before you do:

- **Keep the database on a persistent disk.** Without one, accounts and ratings disappear when the host restarts. Point `DB_PATH` at the disk.
- **Run a single instance.** Live games and the matchmaking queue are held in memory, so a second server instance would split players into separate worlds. Games in progress are lost if the server restarts.
- Matchmaking pairs the first two people waiting. It doesn't look at ratings yet, which is fine for a small group of friends but worth adding if the site grows.
- Passwords are stored hashed (bcrypt). There is no password reset or email, so a forgotten password means a new account.

## Hosting the pages on GitHub Pages

GitHub Pages can only hold the web pages. The game itself (accounts, matchmaking, clocks) needs the Node server, so you run two things:

1. **The server**: deploy this folder to Render (see above). `render.yaml` already allows the address `https://orange12234.github.io` to talk to it. If your pages live somewhere else, set the `ALLOWED_ORIGINS` environment variable on the server to that address (just the site, no path), and `SITE_URL` to the full pages address.
2. **The pages**: run `node build-pages.js https://YOUR-SERVER.onrender.com`. That creates a `pages-site` folder. Upload its contents to your GitHub repository (the `TEST2` one). The pages must be at the top level of the repo, with `index.html` next to `config.js`.

If you only have the pre-built pages, open `config.js`, and change the `server` line to your server's address.

## The Kingside owner account

Whoever signs up with the username **Kingside** becomes the site owner automatically (owners can ban players and make moderators). To use another name, set the `OWNER_USERNAME` environment variable. **Create this account yourself as soon as the site is live**, before anyone else can take the name.

## Premoves

While it is your opponent's turn you can pick one of your pieces and a square (click or drag) to queue a premove. It plays by itself the moment your turn starts, if it is legal then (pawns promote to a queen). Right-click the board or press Esc to cancel it.

## Giving titles (GM, IM, ...)

The owner can give or remove a title straight from a player's profile page: open the profile, pick a title under "Moderation" and press "Save title". The `set-title.js` command still works too.

## Rating refunds for permanent bans

When an account is banned permanently, every rated game it won is undone for the other player: the rating points they lost come back (in the right bullet, blitz or rapid rating) and the loss comes off their record. Draws are left alone, a game is only refunded once, and temporary bans refund nothing. The moderation log shows how many points were returned. Bans made before this feature existed are not refunded retroactively.

## Reporting players

Every profile (except your own) has a **Report player** button. The player types a reason (5 to 500 characters), and the report records who sent it. Moderators and the owner see open reports on the Moderation page and on the reported player's profile, and press "Mark as handled" when they are done. Each player can send up to 5 reports a day, and only one open report per person.

## Cheat detection (fair play)

After every rated game, the server runs Stockfish over the moves in the background (one game at a time, so a small server is not overloaded) and works out each player's accuracy. When a player's last 30 analysed rated games show **both** a win rate of 80% or more **and** an average accuracy of 92% or more (and at least 10 games), a flag is sent to the moderators and the owner. It appears under "Open reports" on the Moderation page and on the player's profile, from "the fair-play system", with the numbers and the game ids to review. The Moderation button shows how many reports are waiting.

A flag is only a reason to look. Nothing happens to the player automatically, and a player is not flagged again until they have played 5 new games after a flag was handled. Games shorter than 20 moves (plies) are not scored.

You can tune it with environment variables on the server: `FAIRPLAY=off`, `FAIRPLAY_MIN_GAMES`, `FAIRPLAY_WIN_RATE` (0.8), `FAIRPLAY_ACCURACY` (92) and `FAIRPLAY_DEPTH` (10; higher is slower and more exact).

## Email at sign-up

Creating an account needs an email address. It is private (other players never see it; only the owner can see it on a player's profile). The same mailbox written differently counts as the same address (capitals, `+tags`, dots in Gmail addresses, `googlemail.com`). Accounts that existed before this was added can add their email once from their own profile page.

**Linked accounts are banned together.** Several accounts can share one email, but when one of them is banned, every other account with that email gets the same ban for the same reason (same length, and a permanent ban refunds the lost rating points for all of them). Moderators and the owner are never banned this way by another moderator, and the result message lists who was banned and who was skipped. The owner sees the other accounts that share an email on the player's profile. While an email belongs to a banned account it cannot be used to sign up again ("This email belongs to a banned account"). Lifting a ban only lifts it for the account you choose.

The site does not send a confirmation email, so it cannot tell whether an address really belongs to the person typing it. Someone who is banned can still come back with a different email address. Confirmation emails need an email service (an account with a provider such as Resend or Mailgun) and would be the next step.

## Play bots (Stockfish)

The **Play bots** button (bottom-left, above "Analyse a PGN") opens a page where you play against Stockfish. A slider sets the difficulty from level 1 (Beginner, about 400 rating) to level 8 (full strength); levels 4 to 7 use Stockfish's own strength limit (1400, 1800, 2200 and 2600), and the easier levels search very shallowly and sometimes play a random move. You choose White, Black or Random. Click or drag pieces, take moves back, flip the board or resign, and press "Game review" afterwards to see the game analysed. Bot games are casual and never change a rating. Stockfish runs in the player's browser, so it costs the server nothing and works on the GitHub Pages version too.

## How much rating a game is worth

The higher your rating, the less a game moves it, so climbing gets slower near the top. Each player's own rating sets the size of their swing (the "K factor"): 32 up to a rating of 1200, falling steadily to 10 at 2400 and above. For example, a win against an equally rated opponent gives +16 at 1200, +13 at 1500, +11 at 1800, +8 at 2100 and +5 at 2400. Beating someone much weaker gives very little (never less than +1), and an upset win over someone much stronger gives a lot. Because each player has their own swing size, a game can move the two ratings by different amounts. Games played before this change keep the points they were worth at the time. To change the numbers, edit `K_MAX`, `K_MIN`, `K_FROM` and `K_TO` near the top of `server.js`.

## Setting ratings by hand (owner)

The owner can set anyone's bullet, blitz or rapid rating: open the player's profile, and under "Moderation" pick the category, type the rating (100 to 3500) and press "Set rating". Their win/loss record is not changed, the profile says "Set by the owner" if they have not played rated games there, and they appear on that leaderboard. Each change is written to the moderation log with the old and new rating.

## Aborting a game
Until you have made your first move you can press **Abort game** instead of Resign (White before moving, Black before replying). An aborted game is never rated and changes nobody's rating. Aborting a lot is reported: after 3 aborts in 24 hours the player gets a warning, and at 5 the owner and moderators get a flag from "Fair-play system" under Moderation, listing the game ids. It is only a flag, nothing happens to the player automatically. Change the limit with the `FAIRPLAY_ABORT_LIMIT` environment variable (default 5).

## Daily puzzle
The lobby has a **Daily puzzle** button. Everybody gets the same forced-mate puzzle (mate in 2 or 3) on a given day; a new one appears at midnight (the player's local time). Move the pieces by clicking or dragging. A wrong move is taken back, **Hint** highlights the piece to move, and **Show solution** plays it out (that does not count towards the streak). Solved days and the streak are remembered in the browser, so they work on GitHub Pages too, but they are per browser, not per account.

The puzzles live in `public/puzzles.json` (370 of them, so the list repeats after a year). They were found by letting Stockfish play itself and keeping only positions where the mating move is the only winning move at every step. To make a fresh set, run `node tools/make-puzzles.js 400` (takes 20-30 minutes) and re-upload.

## Rules page
The lobby has a **Rules** button (`#/rules`) and the sign-up form links to it. It covers fair play, ratings, aborting, behaviour, accounts and emails, reporting, and what happens when rules are broken. The text is in `public/index.html` (the `view-rules` section) if you want to change it.

## Badges next to names
Titles (GM, IM...) and staff badges (**Owner**, **Mod**) are shown next to a player's name during a game and on the game review page, as well as on profiles.

## Friends and challenges
Logged-in players have a **Friends** card in the lobby: add a friend by username (they accept or decline), see who is online (green dot), and press **Challenge** to send a direct, casual game using the time limit picked above. The friend gets a pop-up (it lasts a minute) and the game starts when they accept. A friend who is in a game shows a **Watch** button instead. Profiles have an **Add friend** / **Friends (remove)** button.

## Watch live games
The lobby lists rated games in progress (highest rated first) with a **Watch** button. Casual games between friends are not listed. A profile shows **Watch their game** while the player is in a rated game, and owner and moderators see it for any game, which helps when looking into a flagged player.

## Ban appeals
On a banned account's login attempt there is an **Appeal this ban** button. The player writes a message (20-1000 characters) and proves who they are with their password; one open appeal per account. Appeals appear on the **Moderation** page (and in its count). Staff read them, lift the ban from the player's profile if they decide to, and press "Mark as handled".

## Opening names and mistakes summary
The game review page names the opening for the position you are looking at (using the Lichess openings list, in `public/openings.json`; rebuild it with `node tools/make-openings.js a.tsv b.tsv c.tsv d.tsv e.tsv`) and says where named theory ended. After the analysis finishes, **Mistakes to work on** shows, for each player, how many mistakes and blunders they made, in which phase of the game and with which piece, missed or allowed mates, thrown-away winning positions, and the three biggest mistakes (click to jump to them). If you are one of the players the totals of your last reviewed games on this device are added.

## Phones
The top bar and cards fit small screens. Pieces can be dragged with a finger (the piece floats a little above your finger so it stays visible) or moved by tapping the piece and then the square.

## Tournaments
Only the owner can start a tournament: open **Tournaments** in the top bar, fill in the name, time limit, length (10-180 minutes) and when it starts (0 = right away, up to 120 minutes ahead), and press Create. At most 3 can be open at once. The owner can also press **Start now** on an upcoming one, or **End now** / **Cancel** on any.

It is an arena: everyone who joins and is online is paired with another free player automatically, and about 8 seconds after a game ends the next pairing happens (never the same opponent twice in a row if somebody else is free). Win = 2 points, draw = 1, loss = 0, and a player with two or more wins in a row scores double. No new games start in the last 20 seconds, but games in progress still count. Games are **rated**. A player who does not move in a tournament game (aborted) is paused until they press Resume, so they do not keep dragging opponents into empty games. The lobby shows a Tournaments card while one is open. Tournaments are saved in the database and survive a restart; finished ones stay in the "Recent results" list.
