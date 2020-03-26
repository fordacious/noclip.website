import { DataFetcher } from '../DataFetcher';
import { GfxDevice } from '../gfx/platform/GfxPlatform';

import { GameInfo } from './scenes';
import { Model, ModelCollection } from './models';
import { SFATextureCollection } from './textures';
import { dataSubarray } from './util';
import { MaterialFactory } from './shaders';
import { SFAAnimationController } from './animation';

export class SFAObject {
    public name: string;
    public objClass: number;
    public yaw: number = 0;
    public pitch: number = 0;
    public roll: number = 0;
    public scale: number = 1.0;
    public models: Model[] = [];

    constructor(public objType: number, private data: DataView, private isEarlyObject: boolean) {
        // FIXME: where are these fields for early objects?
        this.scale = data.getFloat32(0x4);
        this.objClass = data.getInt16(0x50);

        this.name = '';
        let offs = isEarlyObject ? 0x58 : 0x91;
        let c;
        while ((c = data.getUint8(offs)) != 0) {
            this.name += String.fromCharCode(c);
            offs++;
        }
    }

    public async create(device: GfxDevice, materialFactory: MaterialFactory, modelColl: ModelCollection) {
        const data = this.data;

        const numModels = data.getUint8(0x55);
        const modelListOffs = data.getUint32(0x8);
        for (let i = 0; i < numModels; i++) {
            const modelNum = data.getUint32(modelListOffs + i * 4);
            try {
                const model = modelColl.loadModel(device, materialFactory, modelNum);
                this.models.push(model);
            } catch (e) {
                console.warn(`Failed to load model ${modelNum} due to exception:`);
                console.error(e);
            }
        }
    }
}

export class ObjectManager {
    private objectsTab: DataView;
    private objectsBin: DataView;
    private objindexBin: DataView | null;
    private modelColl: ModelCollection;

    constructor(private gameInfo: GameInfo, private texColl: SFATextureCollection, private animController: SFAAnimationController, private useEarlyObjects: boolean) {
    }

    public async create(dataFetcher: DataFetcher, subdir: string) {
        const pathBase = this.gameInfo.pathBase;
        this.modelColl = new ModelCollection(this.texColl, this.animController, this.gameInfo);
        const [objectsTab, objectsBin, objindexBin, _] = await Promise.all([
            dataFetcher.fetchData(`${pathBase}/OBJECTS.tab`),
            dataFetcher.fetchData(`${pathBase}/OBJECTS.bin`),
            !this.useEarlyObjects ? dataFetcher.fetchData(`${pathBase}/OBJINDEX.bin`) : null,
            this.modelColl.create(dataFetcher, subdir),
        ]);
        this.objectsTab = objectsTab.createDataView();
        this.objectsBin = objectsBin.createDataView();
        this.objindexBin = !this.useEarlyObjects ? objindexBin!.createDataView() : null;
    }

    public async loadObject(device: GfxDevice, materialFactory: MaterialFactory, objType: number, skipObjindex: boolean = false): Promise<SFAObject> {
        if (!this.useEarlyObjects && !skipObjindex) {
            objType = this.objindexBin!.getUint16(objType * 2);
        }
        const offs = this.objectsTab.getUint32(objType * 4);
        const obj = new SFAObject(objType, dataSubarray(this.objectsBin, offs), this.useEarlyObjects);
        await obj.create(device, materialFactory, this.modelColl);
        return obj;
    }
}