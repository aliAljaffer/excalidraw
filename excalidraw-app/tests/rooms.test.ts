import { describe, expect, it } from "vitest";

import { roomWriteToken } from "../data/rooms";

describe("roomWriteToken", () => {
  it("is stable for the same room key and differs for another", async () => {
    const a = await roomWriteToken("sTdLvMC_M3V8_vGa3UVRDg");
    const b = await roomWriteToken("sTdLvMC_M3V8_vGa3UVRDg");
    const c = await roomWriteToken("AAAAAAAAAAAAAAAAAAAAAA");

    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("is url safe base64 without padding", async () => {
    const token = await roomWriteToken("sTdLvMC_M3V8_vGa3UVRDg");
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token).toHaveLength(43);
  });
});
