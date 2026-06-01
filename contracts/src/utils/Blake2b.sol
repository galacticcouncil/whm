// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @title Blake2b - Blake2b-256 wrapper using the EIP-152 blake2f precompile
library Blake2b {
    address constant BLAKE2F = address(0x09);

    /// @notice Blake2b-256 via EVM precompile (EIP-152, single block, max 128 bytes)
    /// @dev Input layout (213 bytes):
    ///   [0:3]     rounds    = 12 (big-endian uint32)
    ///   [4:67]    h         = Blake2b-256 IV (8 x uint64 LE)
    ///   [68:195]  m         = message block (zero-padded to 128 bytes)
    ///   [196:211] t         = (msg_len, 0) as 2 x uint64 LE
    ///   [212]     f         = 0x01 (final block)
    function blake2b256(bytes memory data) internal view returns (bytes32) {
        bytes memory input = new bytes(213);
        uint256 len = data.length;

        assembly {
            let p := add(input, 32)

            // rounds = 12
            mstore8(add(p, 3), 12)

            // h[0..3] = IV XOR param_block (digest=32, key=0, fanout=1, depth=1)
            mstore(add(p, 4), 0x28c9bdf267e6096a3ba7ca8485ae67bb2bf894fe72f36e3cf1361d5f3af54fa5)
            // h[4..7] = IV (unmodified, param_block bytes are zero)
            mstore(add(p, 36), 0xd182e6ad7f520e511f6c3e2b8c68059b6bbd41fbabd9831f79217e1319cde05b)

            // t[0] = message length (LE uint64, <=128 fits in 1 byte)
            mstore8(add(p, 196), len)

            // f = 1 (final block)
            mstore8(add(p, 212), 1)
        }

        // Copy message into block at offset 68
        for (uint256 i = 0; i < len; i++) {
            input[68 + i] = data[i];
        }

        (bool ok, bytes memory out) = BLAKE2F.staticcall(input);
        require(ok, "Blake2f precompile failed");

        bytes32 result;
        assembly {
            result := mload(add(out, 32))
        }
        return result;
    }
}
