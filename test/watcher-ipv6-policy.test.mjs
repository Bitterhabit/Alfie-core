import test from "node:test";
import assert from "node:assert/strict";
import { isPrivateOrReservedIpv6 } from "../src/watchers/engine.mjs";

test("IPv6 watcher target policy blocks IANA special-purpose allocations", () => {
  for (const ip of ["2001:1::1", "2001:2::1", "2001:3::1", "2001:4::1", "2001:db8::1", "2002::1", "3fff::1"]) {
    assert.equal(isPrivateOrReservedIpv6(ip), true, ip);
  }
});

test("IPv6 watcher target policy permits ordinary global unicast addresses", () => {
  for (const ip of ["2606:4700:4700::1111", "2001:4860:4860::8888"]) {
    assert.equal(isPrivateOrReservedIpv6(ip), false, ip);
  }
});
