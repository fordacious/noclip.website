import * as Viewer from '../viewer';
import { GfxRenderInstManager } from "../gfx/render/GfxRenderer";
import { fillSceneParamsDataOnTemplate } from '../gx/gx_render';
import { GfxDevice } from '../gfx/platform/GfxPlatform';
import { SceneContext } from '../SceneBase';
import { mat4 } from 'gl-matrix';
import { nArray } from '../util';
import { ColorTexture } from '../gfx/helpers/RenderTargetHelpers';

import { SFARenderer } from './render';
import { BlockCollection, BlockRenderer, IBlockCollection } from './blocks';
import { SFA_GAME_INFO, GameInfo } from './scenes';
import { MaterialFactory } from './shaders';
import { SFAAnimationController } from './animation';

export interface BlockInfo {
    mod: number;
    sub: number;
}

export interface MapInfo {
    mapsBin: DataView;
    locationNum: number;
    infoOffset: number;
    blockTableOffset: number;
    blockCols: number;
    blockRows: number;
    originX: number;
    originZ: number;
}

export function getBlockInfo(mapsBin: DataView, mapInfo: MapInfo, x: number, y: number): BlockInfo | null {
    const blockIndex = y * mapInfo.blockCols + x;
    const blockInfo = mapsBin.getUint32(mapInfo.blockTableOffset + 4 * blockIndex);
    const sub = (blockInfo >>> 17) & 0x3F;
    const mod = (blockInfo >>> 23);
    if (mod == 0xff) {
        return null;
    }
    return {mod, sub};
}

function getMapInfo(mapsTab: DataView, mapsBin: DataView, locationNum: number): MapInfo {
    const offs = locationNum * 0x1c;
    const infoOffset = mapsTab.getUint32(offs + 0x0);
    const blockTableOffset = mapsTab.getUint32(offs + 0x4);

    const blockCols = mapsBin.getUint16(infoOffset + 0x0);
    const blockRows = mapsBin.getUint16(infoOffset + 0x2);

    return {
        mapsBin, locationNum, infoOffset, blockTableOffset, blockCols, blockRows,
        originX: mapsBin.getInt16(infoOffset + 0x4),
        originZ: mapsBin.getInt16(infoOffset + 0x6),
    };
}

// Block table is addressed by blockTable[y][x].
function getBlockTable(mapInfo: MapInfo): (BlockInfo | null)[][] {
    const blockTable: (BlockInfo | null)[][] = [];
    for (let y = 0; y < mapInfo.blockRows; y++) {
        const row: (BlockInfo | null)[] = [];
        blockTable.push(row);
        for (let x = 0; x < mapInfo.blockCols; x++) {
            const blockInfo = getBlockInfo(mapInfo.mapsBin, mapInfo, x, y);
            row.push(blockInfo);
        }
    }

    return blockTable;
}

interface MapSceneInfo {
    getNumCols(): number;
    getNumRows(): number;
    getBlockCollection(mod: number): Promise<IBlockCollection>;
    getBlockInfoAt(col: number, row: number): BlockInfo | null;
    getOrigin(): number[];
}

interface BlockIter {
    x: number;
    z: number;
    block: BlockRenderer;
}

export class MapInstance {
    private matrix: mat4 = mat4.create();
    private numRows: number;
    private numCols: number;
    private blockCollections: IBlockCollection[] = [];
    private blockInfoTable: (BlockInfo | null)[][] = []; // Addressed by blockInfoTable[z][x]
    private blocks: (BlockRenderer | null)[][] = []; // Addressed by blocks[z][x]

    constructor(private info: MapSceneInfo) {
        this.numRows = info.getNumRows();
        this.numCols = info.getNumCols();

        for (let y = 0; y < this.numRows; y++) {
            const row: (BlockInfo | null)[] = [];
            this.blockInfoTable.push(row);
            for (let x = 0; x < this.numCols; x++) {
                const blockInfo = info.getBlockInfoAt(x, y);
                row.push(blockInfo);
            }
        }
    }
    
    public clearBlocks() {
        this.blocks = [];
    }

    // Caution: Matrix will be referenced, not copied.
    public setMatrix(matrix: mat4) {
        this.matrix = matrix;
    }

    public getNumDrawSteps(): number {
        return 3;
    }

    public* iterateBlocks(): Generator<BlockIter, void> {
        for (let z = 0; z < this.blocks.length; z++) {
            const row = this.blocks[z];
            for (let x = 0; x < row.length; x++) {
                if (row[x] !== null) {
                    yield { x, z, block: row[x]! };
                }
            }
        }
    }

    public getBlockAtPosition(x: number, z: number): BlockRenderer | null {
        const bx = Math.floor(x / 640);
        const bz = Math.floor(z / 640);
        const block = this.blocks[bz][bx];
        if (block === undefined) {
            return null;
        }
        return block;
    }

    public prepareToRender(device: GfxDevice, renderInstManager: GfxRenderInstManager, viewerInput: Viewer.ViewerRenderInput, sceneTexture: ColorTexture, drawStep: number) {
        const template = renderInstManager.pushTemplateRenderInst();
        fillSceneParamsDataOnTemplate(template, viewerInput, false);

        const matrix = mat4.create();
        for (let b of this.iterateBlocks()) {
            mat4.fromTranslation(matrix, [640 * b.x, 0, 640 * b.z]);
            mat4.mul(matrix, this.matrix, matrix);
            b.block.prepareToRender(device, renderInstManager, viewerInput, matrix, sceneTexture, drawStep);
        }

        renderInstManager.popTemplateRenderInst();
    }

    public prepareToRenderWaters(device: GfxDevice, renderInstManager: GfxRenderInstManager, viewerInput: Viewer.ViewerRenderInput, sceneTexture: ColorTexture) {
        const template = renderInstManager.pushTemplateRenderInst();
        fillSceneParamsDataOnTemplate(template, viewerInput, false);

        const matrix = mat4.create();
        for (let b of this.iterateBlocks()) {
            mat4.fromTranslation(matrix, [640 * b.x, 0, 640 * b.z]);
            mat4.mul(matrix, this.matrix, matrix);
            b.block.prepareToRenderWaters(device, renderInstManager, viewerInput, matrix, sceneTexture);
        }

        renderInstManager.popTemplateRenderInst();
    }

    public prepareToRenderFurs(device: GfxDevice, renderInstManager: GfxRenderInstManager, viewerInput: Viewer.ViewerRenderInput, sceneTexture: ColorTexture) {
        const template = renderInstManager.pushTemplateRenderInst();
        fillSceneParamsDataOnTemplate(template, viewerInput, false);

        const matrix = mat4.create();
        for (let b of this.iterateBlocks()) {
            mat4.fromTranslation(matrix, [640 * b.x, 0, 640 * b.z]);
            mat4.mul(matrix, this.matrix, matrix);
            b.block.prepareToRenderFurs(device, renderInstManager, viewerInput, matrix, sceneTexture);
        }

        renderInstManager.popTemplateRenderInst();
    }

    public async reloadBlocks() {
        this.clearBlocks();
        for (let z = 0; z < this.numRows; z++) {
            const row: (BlockRenderer | null)[] = [];
            this.blocks.push(row);
            for (let x = 0; x < this.numCols; x++) {
                const blockInfo = this.blockInfoTable[z][x];
                if (blockInfo == null) {
                    row.push(null);
                    continue;
                }

                try {
                    if (this.blockCollections[blockInfo.mod] == undefined) {
                        this.blockCollections[blockInfo.mod] = await this.info.getBlockCollection(blockInfo.mod);
                    }
                    const blockColl = this.blockCollections[blockInfo.mod];

                    const blockRenderer = blockColl.getBlock(blockInfo.mod, blockInfo.sub);
                    if (blockRenderer) {
                        row.push(blockRenderer);
                    }
                } catch (e) {
                    console.warn(`Skipping block at ${x},${z} due to exception:`);
                    console.error(e);
                }
            }
        }
    }

    public openEditor(): void {
        const newWin = window.open('about:blank');
        if (!newWin) {
            console.warn(`Failed to open editor. Please allow pop-up windows and try again.`);
            return;
        }
        newWin.onload = () => {
            const inputs: HTMLInputElement[][] = [];
            for (let y = 0; y < this.numRows; y++) {
                const row: HTMLInputElement[] = [];
                inputs.push(row);
                for (let x = 0; x < this.numCols; x++) {
                    const blockInfo = this.blockInfoTable[y][x];
                    const inputEl = newWin.document.createElement('input');
                    inputEl.setAttribute('type', 'text');
                    inputEl.setAttribute('value', `${blockInfo != null ? `${blockInfo.mod}.${blockInfo.sub}` : -1}`);
                    row.push(inputEl);
                }
            }

            const tableEl = newWin.document.createElement('table');
            newWin.document.body.appendChild(tableEl);
            for (let y = 0; y < this.numRows; y++) {
                const trEl = newWin.document.createElement('tr');
                tableEl.appendChild(trEl);
                for (let x = 0 ; x < this.numCols; x++) {
                    const tdEl = newWin.document.createElement('td');
                    trEl.appendChild(tdEl);
                    tdEl.appendChild(inputs[y][x]);
                }
            }

            const jsonEl = newWin.document.createElement('textarea');
            jsonEl.setAttribute('rows', '60');
            jsonEl.setAttribute('cols', '100');
            const updateJson = () => {
                let topRow = -1
                let leftCol = -1
                let rightCol = -1
                let bottomRow = -1
                for (let row = 0; row < this.numRows; row++) {
                    for (let col = 0; col < this.numCols; col++) {
                        const info = this.blockInfoTable[row][col];
                        if (info != null) {
                            if (topRow == -1) {
                                topRow = row;
                            }
                            bottomRow = row;
                            if (leftCol == -1) {
                                leftCol = col;
                            } else if (col < leftCol) {
                                leftCol = col;
                            }
                            if (rightCol == -1) {
                                rightCol = col;
                            } else if (col > rightCol) {
                                rightCol = col;
                            }
                        }
                    }
                }

                if (topRow == -1) {
                    // No blocks found
                    jsonEl.textContent = '[]';
                    return;
                }

                let json = '[';
                for (let row = topRow; row <= bottomRow; row++) {
                    json += row != topRow ? ',\n' : '\n';
                    json += JSON.stringify(this.blockInfoTable[row].slice(leftCol, rightCol + 1),
                        (key, value) => {
                            if (Array.isArray(value)) {
                                return value;
                            } else if (value === null) {
                                return null;
                            } else if (typeof value != 'object') {
                                return null;
                            } else {
                                return `${value.mod}.${value.sub}`;
                            }                
                        });
                }
                json += '\n]';
                jsonEl.textContent = json;
            };

            const submitEl = newWin.document.createElement('input');
            submitEl.setAttribute('type', 'submit');
            newWin.document.body.appendChild(submitEl);
            submitEl.onclick = async() => {
                console.log(`Reloading blocks...`);
                for (let y = 0; y < this.numRows; y++) {
                    for (let x = 0; x < this.numCols; x++) {
                        const newValue = inputs[y][x].value.split('.', 2);
                        if (newValue.length == 2) {
                            const newMod = Number.parseInt(newValue[0]);
                            const newSub = Number.parseInt(newValue[1]);
                            this.blockInfoTable[y][x] = {mod: newMod, sub: newSub}; // TODO: handle failures
                        } else {
                            this.blockInfoTable[y][x] = null;
                        }
                    }
                }
                updateJson();
                await this.reloadBlocks();
            };

            const divEl = newWin.document.createElement('div');
            newWin.document.body.appendChild(divEl);
            divEl.appendChild(jsonEl);
        };
    }
}

export async function loadMap(device: GfxDevice, materialFactory: MaterialFactory, animController: SFAAnimationController, context: SceneContext, mapNum: number, gameInfo: GameInfo, isAncient: boolean = false): Promise<MapSceneInfo> {
    const pathBase = gameInfo.pathBase;
    const dataFetcher = context.dataFetcher;
    const [mapsTab, mapsBin] = await Promise.all([
        dataFetcher.fetchData(`${pathBase}/MAPS.tab`),
        dataFetcher.fetchData(`${pathBase}/MAPS.bin`),
    ]);

    const mapInfo = getMapInfo(mapsTab.createDataView(), mapsBin.createDataView(), mapNum);
    const blockTable = getBlockTable(mapInfo);
    return {
        getNumCols() { return mapInfo.blockCols; },
        getNumRows() { return mapInfo.blockRows; },
        async getBlockCollection(mod: number): Promise<IBlockCollection> {
            const blockColl = new BlockCollection(mod, isAncient, materialFactory, animController);
            await blockColl.create(device, context, gameInfo);
            return blockColl;
        },
        getBlockInfoAt(col: number, row: number): BlockInfo | null {
            return blockTable[row][col];
        },
        getOrigin(): number[] {
            return [mapInfo.originX, mapInfo.originZ];
        }
    };
}

class MapSceneRenderer extends SFARenderer {
    private map: MapInstance;

    constructor(device: GfxDevice, animController: SFAAnimationController, private materialFactory: MaterialFactory) {
        super(device, animController);
    }

    public async create(info: MapSceneInfo): Promise<Viewer.SceneGfx> {
        this.map = new MapInstance(info);
        await this.map.reloadBlocks();
        return this;
    }

    // Caution: Matrix will be referenced, not copied.
    public setMatrix(matrix: mat4) {
        this.map.setMatrix(matrix);
    }

    protected update(viewerInput: Viewer.ViewerRenderInput) {
        super.update(viewerInput);
        this.materialFactory.update(this.animController);
    }
    
    protected renderWorld(device: GfxDevice, renderInstManager: GfxRenderInstManager, viewerInput: Viewer.ViewerRenderInput) {
        this.beginPass(viewerInput);
        this.map.prepareToRender(device, renderInstManager, viewerInput, this.sceneTexture, 0);
        this.endPass(device);

        this.beginPass(viewerInput);
        this.map.prepareToRenderWaters(device, renderInstManager, viewerInput, this.sceneTexture);
        this.map.prepareToRenderFurs(device, renderInstManager, viewerInput, this.sceneTexture);
        this.endPass(device);

        for (let drawStep = 1; drawStep < this.map.getNumDrawSteps(); drawStep++) {
            this.beginPass(viewerInput);
            this.map.prepareToRender(device, renderInstManager, viewerInput, this.sceneTexture, drawStep);
            this.endPass(device);
        }        
    }
}

export class SFAMapSceneDesc implements Viewer.SceneDesc {
    constructor(public mapNum: number, public id: string, public name: string, private gameInfo: GameInfo = SFA_GAME_INFO, private isEarly: boolean = false, private isAncient: boolean = false) {
    }

    public async createScene(device: GfxDevice, context: SceneContext): Promise<Viewer.SceneGfx> {
        console.log(`Creating scene for ${this.name} (map #${this.mapNum}) ...`);

        const animController = new SFAAnimationController();
        const materialFactory = new MaterialFactory(device);
        const mapSceneInfo = await loadMap(device, materialFactory, animController, context, this.mapNum, this.gameInfo, this.isAncient);

        const mapRenderer = new MapSceneRenderer(device, animController, materialFactory);
        await mapRenderer.create(mapSceneInfo);

        // Rotate camera 135 degrees to more reliably produce a good view of the map
        // when it is loaded for the first time.
        const matrix = mat4.create();
        mat4.rotateY(matrix, matrix, Math.PI * 3 / 4);
        mapRenderer.setMatrix(matrix);

        return mapRenderer;
    }
}

export class AncientMapSceneDesc implements Viewer.SceneDesc {
    private materialFactory: MaterialFactory;

    constructor(public id: string, public name: string, private gameInfo: GameInfo, private mapKey: any) {
    }
    
    public async createScene(device: GfxDevice, context: SceneContext): Promise<Viewer.SceneGfx> {
        console.log(`Creating scene for ${this.name} ...`);

        const pathBase = this.gameInfo.pathBase;
        const dataFetcher = context.dataFetcher;
        const mapsJsonBuffer = await dataFetcher.fetchData(`${pathBase}/AncientMaps.json`);

        const animController = new SFAAnimationController();
        const materialFactory = new MaterialFactory(device);
        const mapsJsonString = new TextDecoder('utf-8').decode(mapsJsonBuffer.arrayBuffer);
        const mapsJson = JSON.parse(mapsJsonString);
        const map = mapsJson[this.mapKey];

        const numRows = map.blocks.length;
        const numCols = map.blocks[0].length;
        const blockTable: (BlockInfo | null)[][] = nArray(numRows, () => nArray(numCols, () => null));

        for (let row = 0; row < numRows; row++) {
            for (let col = 0; col < numCols; col++) {
                const b = map.blocks[row][col];
                if (b == null) {
                    blockTable[row][col] = null;
                } else {
                    const newValue = b.split('.', 2);
                    const newMod = Number.parseInt(newValue[0]);
                    const newSub = Number.parseInt(newValue[1]);
                    blockTable[row][col] = {mod: newMod, sub: newSub};
                }
            }
        }

        const self = this;
        const mapSceneInfo: MapSceneInfo = {
            getNumCols() { return numCols; },
            getNumRows() { return numRows; },
            async getBlockCollection(mod: number): Promise<IBlockCollection> {
                const blockColl = new BlockCollection(mod, true, materialFactory, animController);
                await blockColl.create(device, context, self.gameInfo);
                return blockColl;
            },
            getBlockInfoAt(col: number, row: number): BlockInfo | null {
                return blockTable[row][col];
            },
            getOrigin(): number[] {
                return [0, 0];
            }
        };

        const mapRenderer = new MapSceneRenderer(device, animController, materialFactory);
        await mapRenderer.create(mapSceneInfo);

        // Rotate camera 135 degrees to more reliably produce a good view of the map
        // when it is loaded for the first time.
        // FIXME: The best method is to create default save states for each map.
        const matrix = mat4.create();
        mat4.rotateY(matrix, matrix, Math.PI * 3 / 4);
        mapRenderer.setMatrix(matrix);

        return mapRenderer;
    }
}

export class SFASandboxDesc implements Viewer.SceneDesc {
    constructor(public id: string, public name: string, private gameInfo: GameInfo, private isAncient = false) {
    }
    
    public async createScene(device: GfxDevice, context: SceneContext): Promise<Viewer.SceneGfx> {
        console.log(`Creating scene for ${this.name} ...`);

        const materialFactory = new MaterialFactory(device);
        const animController = new SFAAnimationController();
        const COLS = 20;
        const ROWS = 20;
        const blockTable: (BlockInfo | null)[][] = nArray(ROWS, () => nArray(COLS, () => null));

        const self = this;
        const mapSceneInfo: MapSceneInfo = {
            getNumCols() { return COLS; },
            getNumRows() { return ROWS; },
            async getBlockCollection(mod: number): Promise<IBlockCollection> {
                const blockColl = new BlockCollection(mod, self.isAncient, materialFactory, animController);
                await blockColl.create(device, context, self.gameInfo);
                return blockColl;
            },
            getBlockInfoAt(col: number, row: number): BlockInfo | null {
                return blockTable[row][col];
            },
            getOrigin(): number[] {
                return [0, 0];
            }
        };

        console.log(`Welcome to the sandbox. Type main.scene.openEditor() to open the map editor.`);

        const mapRenderer = new MapSceneRenderer(device, animController, materialFactory);
        await mapRenderer.create(mapSceneInfo);
        return mapRenderer;
    }
}
