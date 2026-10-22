# codenames-client

Unofficial TypeScript client for [codenames.game](https://codenames.game), built by reverse-engineering the production JavaScript bundle and WebSocket traffic.

## Status

Experimental and unofficial. This library speaks the codenames.game WebSocket protocol as reverse-engineered from the production bundle — it may break if the server changes its API.

## Usage

```bash
npm install
npm run build
```

```ts
import { createCodenamesProvider, CodenamesClient } from 'codenames-client';
import { firstValueFrom, map } from 'rxjs';

const provider = createCodenamesProvider({
  serverURL: 'https://server-discord.gke.codenames.game',
  clientOpts: {
    credentials: 'your-credentials',
    playerName: 'YourName',
    roomID: 'ROOM-CODE',
  },
});

provider.start();

const bgioClient = await firstValueFrom(provider.state$.pipe(map(s => s.client!)));
const client = new CodenamesClient(bgioClient);

await client.connect();
client.joinTeam('side2');
```

Run the bundled example (creates a new room, or joins if code provided):

```bash
npm run example [ROOM-CODE]
```

## Testing & Verification

Run the integration tests against the live `codenames.game` server:

```bash
# Run all live integration tests
npm test

# Run Duet tests only
npm run test:duet

# Run Classic tests only
npm run test:classic
```

## Protocol Documentation

Detailed reverse-engineered protocol information, past changes, and troubleshooting steps for when the backend changes can be found in:
- [`docs/protocol-and-troubleshooting.md`](docs/protocol-and-troubleshooting.md)
- [`docs/CHANGELOG.md`](docs/CHANGELOG.md)

## License

No license is declared for the original code in this repository.

### boardgame.io

The files under `src/bgio/` and `src/client.ts` are derived from
[boardgame.io](https://github.com/boardgameio/boardgame.io) and are used under the
MIT License. Each file carries the original copyright header; the full license text is:

```
MIT License

Copyright (c) 2017 The boardgame.io Authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
