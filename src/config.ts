import { http, createConfig } from "wagmi";
import { arcTestnet, anvil } from "viem/chains";
import { injected } from "wagmi/connectors";
import { registerChain } from "./tracing";
registerChain(arcTestnet.id, arcTestnet.rpcUrls.default.http[0]);
export const config = createConfig({
  chains: [arcTestnet, anvil],
  connectors: [injected()],
  transports: {
    [arcTestnet.id]: http(),
    [anvil.id]: http("http://127.0.0.1:18545"),
  },
});
