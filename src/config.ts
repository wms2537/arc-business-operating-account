import { http, createConfig } from "wagmi";
import { arc, arcTestnet, anvil } from "viem/chains";
import { injected } from "wagmi/connectors";
import { registerChain } from "./tracing";
registerChain(arcTestnet.id, arcTestnet.rpcUrls.default.http[0]);
registerChain(arc.id, arc.rpcUrls.default.http[0]);
export const config = createConfig({
  chains: [arcTestnet, anvil, arc],
  connectors: [injected()],
  transports: {
    [arcTestnet.id]: http(),
    [arc.id]: http(),
    [anvil.id]: http("http://127.0.0.1:18545"),
  },
});
