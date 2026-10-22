import { firstValueFrom, map } from "rxjs";
import { CodenamesClient } from "./CodenamesClient";
import { createCodenamesProvider } from "./provider";

async function run() {
  const roomArg = process.argv.slice(2)[0];
  console.log(roomArg ? `Joining room: ${roomArg}` : "Creating a new room...");

  const provider = createCodenamesProvider({
    serverURL: "https://server-discord.gke.codenames.game",
    gameName: "cnduet",
    clientOpts: {
      playerName: roomArg ? "Guest Player" : "Host Player",
      roomID: roomArg || undefined,
    },
  });

  provider.start();

  const client = await firstValueFrom(
    provider.state$.pipe(
      map((state) => (state.client ? new CodenamesClient(state.client) : null))
    )
  );

  if (!client) {
    throw new Error("Failed to initialize CodenamesClient");
  }

  console.log("Connecting and waiting for sync...");
  await client.waitForSync();

  console.log(`Connected! Room ID: ${client.roomID}, Player ID: ${client.playerID}`);

  if (!client.myTeam) {
    const targetTeam = roomArg ? "side2" : "side1";
    console.log(`Joining team: ${targetTeam}`);
    client.joinTeam(targetTeam);
  }

  console.log(`Current phase: ${client.state?.ctx.phase}`);

  // Wait briefly to observe state update after joinTeam, then shut down cleanly
  await new Promise((resolve) => setTimeout(resolve, 2000));
  console.log(`Assigned team in state: ${client.myTeam}`);
  provider.stop();
  process.exit(0);
}

run().catch((err) => {
  console.error("Error in example:", err);
  process.exit(1);
});