import { TypeRegistry, Enum, Struct } from '@polkadot/types';

// Creates a type registry to properly work with the precompile's input types
const registry = new TypeRegistry();

// Define the precompile's input types VersionedUserAction and XcmRoutingUserAction
// https://github.com/moonbeam-foundation/moonbeam/blob/1d664f3938698a6cd341fb8f36ccc4bb1104f1ff/precompiles/gmp/src/types.rs#L25-L39
export class VersionedUserAction extends Enum {
  constructor(value) {
    super(registry, { V1: XcmRoutingUserAction }, value);
  }
}
class XcmRoutingUserAction extends Struct {
  constructor(value) {
    super(registry, { destination: 'VersionedMultiLocation' }, value);
  }
}

// A function that creates a SCALE encoded payload to use with transferTokensWithPayload
export function createMRLPayload(parachainId, account, isEthereumStyle = false) {
  // Create a multilocation object based on the target parachain's account type
  const versionedMultiLocation = {
    v1: {
      parents: 1,
      interior: {
        X2: [
          { Parachain: parachainId },
          isEthereumStyle ?
            { AccountKey20: { key: account } } :
            { AccountId32: { id: account }
            }]
      }
    }
  };

  // Format multilocation object as a Polkadot.js type
  const destination = registry.createType('VersionedMultiLocation', versionedMultiLocation);

  // Wrap and format the MultiLocation object into the precompile's input type
  const userAction = new XcmRoutingUserAction({ destination });
  const versionedUserAction = new VersionedUserAction({ V1: userAction });

  // SCALE encode resultant precompile formatted objects
  return versionedUserAction.toHex();
}
