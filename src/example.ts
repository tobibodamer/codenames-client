import { firstValueFrom, map } from "rxjs";
import { CodenamesClient } from "./CodenamesClient";
import { CodenamesProvider, createCodenamesProvider } from "./provider";

async function run() {
  const provider = createCodenamesProvider({
    serverURL: "https://server-discord.gke.codenames.game",

    clientOpts: {
      credentials: "basudoha-mozafiri-kofiloka",
      playerName: "Luna",
      roomID: process.argv.slice(2)[0]
    }
  })

  provider.start()

  const client = await firstValueFrom(provider.state$.pipe(map((state) => state.client ? new CodenamesClient(state.client) : null)))

  if (!client) {
    return
  }

  client.subscribe(state => {
    console.log(state?.G)

  })

  await client.connect()

  console.log("Client connected!")

  //client.joinMatch({ matchID: "default", roomID: process.argv.slice(2)[0] })

  if (!client.myTeam) {
    client.joinTeam("side2")
  }

  //client.giveClue("Test", 1, )
}

run().catch(err => console.error(err))