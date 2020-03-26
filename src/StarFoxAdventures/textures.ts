import { hexzero } from '../util';
import ArrayBufferSlice from '../ArrayBufferSlice';
import * as GX_Texture from '../gx/gx_texture';
import { loadTextureFromMipChain, translateWrapModeGfx, translateTexFilterGfx } from '../gx/gx_render';
import { GfxDevice, GfxMipFilterMode, GfxTexture, GfxSampler, GfxFormat, makeTextureDescriptor2D, GfxWrapMode, GfxTexFilterMode } from '../gfx/platform/GfxPlatform';
import { DataFetcher } from '../DataFetcher';

import { GameInfo } from './scenes';
import { loadRes } from './resource';

export interface SFATexture {
    gfxTexture: GfxTexture;
    gfxSampler: GfxSampler;
    width: number;
    height: number;
}

export interface SFATextureArray {
    textures: SFATexture[];
}

export abstract class TextureCollection {
    public abstract getTextureArray(device: GfxDevice, num: number, alwaysUseTex1: boolean): SFATextureArray | null;
    public getTexture(device: GfxDevice, num: number, alwaysUseTex1: boolean) : SFATexture | null {
        const texArray = this.getTextureArray(device, num, alwaysUseTex1);
        if (texArray) {
            return texArray.textures[0];
        } else {
            return null;
        }
    }
}

function loadTexture(device: GfxDevice, texData: ArrayBufferSlice, isBeta: boolean): SFATexture {
    const dv = texData.createDataView();
    const textureInput = {
        name: `Texture`,
        width: dv.getUint16(0x0A),
        height: dv.getUint16(0x0C),
        format: dv.getUint8(0x16),
        mipCount: dv.getUint16(0x1c) + 1,
        data: texData.slice(isBeta ? 0x20 : 0x60),
    };
    const fields = {
        wrapS: dv.getUint8(0x17),
        wrapT: dv.getUint8(0x18),
        minFilt: dv.getUint8(0x19),
        magFilt: dv.getUint8(0x1A),
    };
    
    const mipChain = GX_Texture.calcMipChain(textureInput, textureInput.mipCount);
    const gfxTexture = loadTextureFromMipChain(device, mipChain).gfxTexture;
    
    // GL texture is bound by loadTextureFromMipChain.
    const [minFilter, mipFilter] = translateTexFilterGfx(fields.minFilt);
    const gfxSampler = device.createSampler({
        wrapS: translateWrapModeGfx(fields.wrapS),
        wrapT: translateWrapModeGfx(fields.wrapT),
        minFilter: minFilter,
        magFilter: translateTexFilterGfx(fields.magFilt)[0],
        mipFilter: mipFilter,
        minLOD: 0,
        maxLOD: 100,
    });

    return {
        gfxTexture,
        gfxSampler,
        width: textureInput.width,
        height: textureInput.height,
    };
}

function isValidTextureTabValue(tabValue: number) {
    return tabValue != 0xFFFFFFFF && (tabValue & 0x80000000) != 0;
}

function loadFirstValidTexture(device: GfxDevice, tab: DataView, bin: ArrayBufferSlice, isBeta: boolean): SFATextureArray | null {
    let firstValidId = 0;
    let found = false;
    for (let i = 0; i < tab.byteLength; i += 4) {
        const tabValue = tab.getUint32(i);
        if (tabValue == 0xFFFFFFFF) {
            console.log(`no valid id found`);
            break;
        }
        if (isValidTextureTabValue(tabValue)) {
            found = true;
            break;
        }
        ++firstValidId;
    }
    if (!found) {
        return null;
    }

    return loadTextureArrayFromTable(device, tab, bin, firstValidId, isBeta);
}

function loadTextureArrayFromTable(device: GfxDevice, tab: DataView, bin: ArrayBufferSlice, id: number, isBeta: boolean): (SFATextureArray | null) {
    const tabValue = tab.getUint32(id * 4);
    if (isValidTextureTabValue(tabValue)) {
        const arrayLength = (tabValue >> 24) & 0x3f;
        const binOffs = (tabValue & 0xffffff) * 2;
        if (arrayLength === 1) {
            const compData = bin.slice(binOffs);
            const uncompData = loadRes(compData);
            return { textures: [loadTexture(device, uncompData, isBeta)] };
        } else {
            const result = { textures: [] as SFATexture[] };
            const binDv = bin.createDataView();
            for (let i = 0; i < arrayLength; i++) {
                const texOffs = binDv.getUint32(binOffs + i * 4);
                const compData = bin.slice(binOffs + texOffs);
                const uncompData = loadRes(compData);
                result.textures.push(loadTexture(device, uncompData, isBeta));
            }
            return result;
        }
    } else {
        console.warn(`Texture id 0x${id.toString(16)} (tab value 0x${hexzero(tabValue, 8)}) not found in table. Using first valid texture.`);
        return loadFirstValidTexture(device, tab, bin, isBeta);
    }
}

function makeFakeTexture(device: GfxDevice, num: number): SFATextureArray {
    const gfxTexture = device.createTexture(makeTextureDescriptor2D(GfxFormat.U8_RGBA_NORM, 2, 2, 1));
    const gfxSampler = device.createSampler({
        wrapS: GfxWrapMode.REPEAT,
        wrapT: GfxWrapMode.REPEAT,
        minFilter: GfxTexFilterMode.BILINEAR,
        magFilter: GfxTexFilterMode.BILINEAR,
        mipFilter: GfxMipFilterMode.NO_MIP,
        minLOD: 0,
        maxLOD: 100,
    });

    // Thanks, StackOverflow.
    let seed = num;
    console.log(`Creating fake texture from seed ${seed}`);
    function random() {
        let x = Math.sin(seed++) * 10000;
        return x - Math.floor(x);
    }

    const baseColor = [127 + random() * 127, 127 + random() * 127, 127 + random() * 127];
    const darkBase = [baseColor[0] * 0.7, baseColor[1] * 0.7, baseColor[2] * 0.7];
    const light = [baseColor[0], baseColor[1], baseColor[2], 0xff];
    const dark = [darkBase[0], darkBase[1], darkBase[2], 0xff];

    const pixels = new Uint8Array(4 * 4);
    pixels.set(dark, 0);
    pixels.set(light, 4);
    pixels.set(light, 8);
    pixels.set(dark, 12);

    const hostAccessPass = device.createHostAccessPass();
    hostAccessPass.uploadTextureData(gfxTexture, 0, [pixels]);
    device.submitPass(hostAccessPass);

    return {
        textures: [{
            gfxTexture,
            gfxSampler,
            width: 2,
            height: 2,
        }]
    }
}

class TextureFile {
    private textures: (SFATextureArray | null)[] = [];

    constructor(private tab: DataView, private bin: ArrayBufferSlice, private name: string, private isBeta: boolean) {
    }

    public getTextureArray(device: GfxDevice, num: number): SFATextureArray | null {
        if (this.textures[num] === undefined) {
            try {
                this.textures[num] = loadTextureArrayFromTable(device, this.tab, this.bin, num, this.isBeta);
            } catch (e) {
                console.warn(`Failed to load texture 0x${num.toString(16)} from ${this.name} due to exception:`);
                console.error(e);
                this.textures[num] = makeFakeTexture(device, num);
            }
        }

        return this.textures[num];
    }
}

async function fetchTextureFile(dataFetcher: DataFetcher, tabPath: string, binPath: string, isBeta: boolean): Promise<TextureFile | null> {
    try {
        const [tab, bin] = await Promise.all([
            dataFetcher.fetchData(tabPath),
            dataFetcher.fetchData(binPath),
        ])
        return new TextureFile(tab.createDataView(), bin, binPath, isBeta);
    } catch (e) {
        console.warn(`Failed to fetch texture file due to exception:`);
        console.error(e);
        return null;
    }
}

export class FakeTextureCollection extends TextureCollection {
    textures: SFATextureArray[] = [];

    public getTextureArray(device: GfxDevice, num: number): SFATextureArray | null {
        if (this.textures[num] === undefined) {
            this.textures[num] = makeFakeTexture(device, num);
        }
        return this.textures[num];
    }
}

export class SFATextureCollection extends TextureCollection {
    private textableBin: DataView;
    private texpre: TextureFile | null;
    private tex0: TextureFile | null;
    private tex1: TextureFile | null;
    private fakes: FakeTextureCollection = new FakeTextureCollection();

    constructor(private gameInfo: GameInfo, private isBeta: boolean) {
        super();
    }

    public async create(dataFetcher: DataFetcher, subdir: string) {
        const pathBase = this.gameInfo.pathBase;
        const [textableBin, texpre, tex0, tex1] = await Promise.all([
            dataFetcher.fetchData(`${pathBase}/TEXTABLE.bin`),
            fetchTextureFile(dataFetcher,
                `${pathBase}/TEXPRE.tab`,
                `${pathBase}/TEXPRE.bin`, false), // TEXPRE is never beta
            fetchTextureFile(dataFetcher,
                `${pathBase}/${subdir}/TEX0.tab`,
                `${pathBase}/${subdir}/TEX0.bin`, this.isBeta),
            fetchTextureFile(dataFetcher,
                `${pathBase}/${subdir}/TEX1.tab`,
                `${pathBase}/${subdir}/TEX1.bin`, this.isBeta),
        ]);
        this.textableBin = textableBin!.createDataView();
        this.texpre = texpre;
        this.tex0 = tex0;
        this.tex1 = tex1;
    }

    public getTextureArray(device: GfxDevice, texId: number, alwaysUseTex1: boolean = false): SFATextureArray | null {
        let file: TextureFile | null;
        if (alwaysUseTex1) {
            file = this.tex1;
        } else {
            const textableValue = this.textableBin.getUint16(texId * 2);
            console.log(`texid ${texId} translated to textable value ${textableValue}`);
            if (texId < 3000 || textableValue == 0) {
                texId = textableValue;
                file = this.tex0;
                console.log(`translated to tex0 num ${texId}`);
            } else {
                texId = textableValue + 1;
                file = this.texpre;
                console.log(`translated to texpre num ${texId}`);
            }
        }

        if (file === null) {
            return this.fakes.getTextureArray(device, texId);
        }

        return file.getTextureArray(device, texId);
    }
}