import { readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";
import pngToIco from "png-to-ico";

const source = await readFile(new URL("../build-resources/icon.svg", import.meta.url));
const png = await sharp(source).resize(512, 512).png().toBuffer();
await writeFile(new URL("../build-resources/icon.png", import.meta.url), png);
await writeFile(new URL("../build-resources/icon.ico", import.meta.url), await pngToIco(png));
