import { required, requiredAddress } from "../../env";

export const APP_NAME = "relayer";

export const source = {
  name: "ethereum",
  wssUrl: required("ETH_WSS"),
  receiver: requiredAddress("INTENT_RECEIVER"),
};
