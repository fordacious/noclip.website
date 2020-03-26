import { mat4, vec3 } from 'gl-matrix';
import { DataFetcher } from '../DataFetcher';
import * as Viewer from '../viewer';
import { GfxDevice } from '../gfx/platform/GfxPlatform';
import { GfxRenderInstManager, GfxRenderInst } from "../gfx/render/GfxRenderer";
import { SceneContext } from '../SceneBase';
import { TDDraw } from "../SuperMarioGalaxy/DDraw";
import * as GX from '../gx/gx_enum';
import { ub_PacketParams, u_PacketParamsBufferSize, fillPacketParamsData } from "../gx/gx_render";
import { ViewerRenderInput } from "../viewer";
import { fillSceneParamsDataOnTemplate, PacketParams, GXMaterialHelperGfx, MaterialParams } from '../gx/gx_render';
import { getDebugOverlayCanvas2D, drawWorldSpaceText, drawWorldSpacePoint, drawWorldSpaceLine } from "../DebugJunk";
import { getMatrixAxisZ } from '../MathHelpers';

import { SFA_GAME_INFO, SFADEMO_GAME_INFO, GameInfo } from './scenes';
import { loadRes } from './resource';
import { ObjectManager, SFAObject } from './objects';
import { EnvfxManager } from './envfx';
import { SFATextureCollection } from './textures';
import { SFARenderer } from './render';
import { GXMaterialBuilder } from '../gx/GXMaterialBuilder';
import { MapInstance, loadMap } from './maps';
import { createDownloadLink, dataSubarray, interpS16 } from './util';
import { Model, ModelVersion } from './models';
import { MaterialFactory } from './shaders';
import { SFAAnimationController } from './animation';

const materialParams = new MaterialParams();
const packetParams = new PacketParams();

function submitScratchRenderInst(device: GfxDevice, renderInstManager: GfxRenderInstManager, materialHelper: GXMaterialHelperGfx, renderInst: GfxRenderInst, viewerInput: ViewerRenderInput, noViewMatrix: boolean = false, materialParams_ = materialParams, packetParams_ = packetParams): void {
    materialHelper.setOnRenderInst(device, renderInstManager.gfxRenderCache, renderInst);
    renderInst.setSamplerBindingsFromTextureMappings(materialParams_.m_TextureMapping);
    const offs = materialHelper.allocateMaterialParams(renderInst);
    materialHelper.fillMaterialParamsDataOnInst(renderInst, offs, materialParams_);
    renderInst.allocateUniformBuffer(ub_PacketParams, u_PacketParamsBufferSize);
    if (noViewMatrix) {
        mat4.identity(packetParams_.u_PosMtx[0]);
    } else {
        mat4.copy(packetParams_.u_PosMtx[0], viewerInput.camera.viewMatrix);
    }
    fillPacketParamsData(renderInst.mapUniformBufferF32(ub_PacketParams), renderInst.getUniformBufferOffset(ub_PacketParams), packetParams_);
    renderInstManager.submitRenderInst(renderInst);
}

function vecPitch(v: vec3): number {
    return Math.atan2(v[1], Math.hypot(v[2], v[0]));
}

interface ObjectInstance {
    name: string;
    obj: SFAObject;
    pos: vec3;
    radius: number;
    model?: Model;
}

async function testLoadingAModel(device: GfxDevice, dataFetcher: DataFetcher, gameInfo: GameInfo, subdir: string, modelNum: number, modelVersion?: ModelVersion): Promise<Model | null> {
    const pathBase = gameInfo.pathBase;
    const texColl = new SFATextureCollection(gameInfo, modelVersion === ModelVersion.Beta);
    const [modelsTabData, modelsBin, _] = await Promise.all([
        dataFetcher.fetchData(`${pathBase}/${subdir}/MODELS.tab`),
        dataFetcher.fetchData(`${pathBase}/${subdir}/MODELS.bin`),
        texColl.create(dataFetcher, subdir),
    ]);
    const modelsTab = modelsTabData.createDataView();

    const modelTabValue = modelsTab.getUint32(modelNum * 4);
    if (modelTabValue === 0) {
        throw Error(`Model #${modelNum} not found`);
    }

    const modelOffs = modelTabValue & 0xffffff;
    const modelData = loadRes(modelsBin.subarray(modelOffs + 0x24));
    
    // window.main.downloadModel = () => {
    //     const aEl = createDownloadLink(modelData, `model_${subdir}_${modelNum}.bin`);
    //     aEl.click();
    // };
    
    try {
        return new Model(device, new MaterialFactory(device), modelData, texColl, new SFAAnimationController(), modelVersion);
    } catch (e) {
        console.warn(`Failed to load model due to exception:`);
        console.error(e);
        return null;
    }
}

class WorldRenderer extends SFARenderer {
    private ddraw = new TDDraw();
    private materialHelperSky: GXMaterialHelperGfx;

    constructor(device: GfxDevice, animController: SFAAnimationController, private materialFactory: MaterialFactory, private envfxMan: EnvfxManager, private mapInstance: MapInstance, private objectInstances: ObjectInstance[], private models: (Model | null)[]) {
        super(device, animController);

        packetParams.clear();

        const atmos = this.envfxMan.atmosphere;
        for (let i = 0; i < 8; i++) {
            const tex = atmos.textures[i]!;
            materialParams.m_TextureMapping[i].gfxTexture = tex.gfxTexture;
            materialParams.m_TextureMapping[i].gfxSampler = tex.gfxSampler;
            materialParams.m_TextureMapping[i].width = tex.width;
            materialParams.m_TextureMapping[i].height = tex.height;
            materialParams.m_TextureMapping[i].lodBias = 0.0;
            mat4.identity(materialParams.u_TexMtx[i]);
        }

        this.ddraw.setVtxDesc(GX.Attr.POS, true);
        this.ddraw.setVtxDesc(GX.Attr.TEX0, true);
        this.ddraw.setVtxAttrFmt(GX.VtxFmt.VTXFMT0, GX.Attr.POS, GX.CompCnt.POS_XYZ);
        this.ddraw.setVtxAttrFmt(GX.VtxFmt.VTXFMT0, GX.Attr.TEX0, GX.CompCnt.TEX_ST);

        let mb = new GXMaterialBuilder();
        mb.setTexCoordGen(GX.TexCoordID.TEXCOORD0, GX.TexGenType.MTX2x4, GX.TexGenSrc.TEX0, GX.TexGenMatrix.IDENTITY);
        mb.setTevDirect(0);
        mb.setTevOrder(0, GX.TexCoordID.TEXCOORD0, GX.TexMapID.TEXMAP0, GX.RasColorChannelID.COLOR_ZERO);
        mb.setTevColorIn(0, GX.CC.ZERO, GX.CC.ZERO, GX.CC.ZERO, GX.CC.TEXC);
        mb.setTevColorOp(0, GX.TevOp.ADD, GX.TevBias.ZERO, GX.TevScale.SCALE_1, true, GX.Register.PREV);
        mb.setTevAlphaIn(0, GX.CA.ZERO, GX.CA.ZERO, GX.CA.ZERO, GX.CA.TEXA);
        mb.setTevAlphaOp(0, GX.TevOp.ADD, GX.TevBias.ZERO, GX.TevScale.SCALE_1, true, GX.Register.PREV);
        mb.setBlendMode(GX.BlendMode.NONE, GX.BlendFactor.ONE, GX.BlendFactor.ZERO);
        mb.setZMode(false, GX.CompareType.ALWAYS, false);
        mb.setCullMode(GX.CullMode.NONE);
        mb.setUsePnMtxIdx(false);
        this.materialHelperSky = new GXMaterialHelperGfx(mb.finish('sky'));
    }

    protected update(viewerInput: Viewer.ViewerRenderInput) {
        super.update(viewerInput);
        this.materialFactory.update(this.animController);
    }

    protected renderSky(device: GfxDevice, renderInstManager: GfxRenderInstManager, viewerInput: ViewerRenderInput) {
        this.beginPass(viewerInput, true);

        const atmos = this.envfxMan.atmosphere;
        const atmosTexture = atmos.textures[0]!;

        // Extract pitch
        const cameraFwd = vec3.create();
        getMatrixAxisZ(cameraFwd, viewerInput.camera.worldMatrix);
        vec3.negate(cameraFwd, cameraFwd);
        const camPitch = vecPitch(cameraFwd);
        const camRoll = Math.PI / 2;

        // Draw atmosphere
        // FIXME: This implementation is adapted from the game, but correctness is not verified.
        // We should probably use a different technique, since this one works poorly in VR.
        // TODO: Implement time of day, which the game implements by blending gradient textures on the CPU.
        const fovRollFactor = 3.0 * (atmosTexture.height * 0.5 * viewerInput.camera.fovY / Math.PI) * Math.sin(-camRoll);
        const pitchFactor = (0.5 * atmosTexture.height - 6.0) - (3.0 * atmosTexture.height * camPitch / Math.PI);
        const t0 = (pitchFactor + fovRollFactor) / atmosTexture.height;
        const t1 = t0 - (fovRollFactor * 2.0) / atmosTexture.height;

        this.ddraw.beginDraw();
        this.ddraw.begin(GX.Command.DRAW_QUADS);
        this.ddraw.position3f32(-1, -1, -1);
        this.ddraw.texCoord2f32(GX.Attr.TEX0, 1.0, t1);
        this.ddraw.position3f32(-1, 1, -1);
        this.ddraw.texCoord2f32(GX.Attr.TEX0, 1.0, t0);
        this.ddraw.position3f32(1, 1, -1);
        this.ddraw.texCoord2f32(GX.Attr.TEX0, 1.0, t0);
        this.ddraw.position3f32(1, -1, -1);
        this.ddraw.texCoord2f32(GX.Attr.TEX0, 1.0, t1);
        this.ddraw.end();

        const renderInst = this.ddraw.makeRenderInst(device, renderInstManager);
        submitScratchRenderInst(device, renderInstManager, this.materialHelperSky, renderInst, viewerInput, true);

        this.ddraw.endAndUpload(device, renderInstManager);
        
        this.endPass(device);
    }

    private renderTestModel(device: GfxDevice, renderInstManager: GfxRenderInstManager, viewerInput: Viewer.ViewerRenderInput, matrix: mat4, model: Model) {
        model.prepareToRender(device, renderInstManager, viewerInput, matrix, this.sceneTexture, 0);

        // Draw bones
        const drawBones = false;
        if (drawBones) {
            const ctx = getDebugOverlayCanvas2D();
            for (let i = 1; i < model.joints.length; i++) {
                const joint = model.joints[i];
                const jointMtx = mat4.clone(model.boneMatrices[i]);
                mat4.mul(jointMtx, jointMtx, matrix);
                const jointPt = vec3.create();
                mat4.getTranslation(jointPt, jointMtx);
                if (joint.parent != 0xff) {
                    const parentMtx = mat4.clone(model.boneMatrices[joint.parent]);
                    mat4.mul(parentMtx, parentMtx, matrix);
                    const parentPt = vec3.create();
                    mat4.getTranslation(parentPt, parentMtx);
                    drawWorldSpaceLine(ctx, viewerInput.camera, parentPt, jointPt);
                } else {
                    drawWorldSpacePoint(ctx, viewerInput.camera, jointPt);
                }
            }
        }
    }

    protected renderWorld(device: GfxDevice, renderInstManager: GfxRenderInstManager, viewerInput: ViewerRenderInput) {
        // Render opaques
        this.beginPass(viewerInput);
        this.mapInstance.prepareToRender(device, renderInstManager, viewerInput, this.sceneTexture, 0);
        
        const mtx = mat4.create();
        for (let i = 0; i < this.objectInstances.length; i++) {
            const obj = this.objectInstances[i];
            if (obj.model) {
                mat4.fromTranslation(mtx, obj.pos);
                mat4.scale(mtx, mtx, [obj.obj.scale, obj.obj.scale, obj.obj.scale]);
                mat4.rotateY(mtx, mtx, obj.obj.yaw);
                mat4.rotateX(mtx, mtx, obj.obj.pitch);
                mat4.rotateZ(mtx, mtx, obj.obj.roll);
                this.renderTestModel(device, renderInstManager, viewerInput, mtx, obj.model);
            }
        }
        
        for (let i = 0; i < this.models.length; i++) {
            if (this.models[i] !== null) {
                mat4.fromTranslation(mtx, [i * 30, 0, 0]);
                this.renderTestModel(device, renderInstManager, viewerInput, mtx, this.models[i]!);
            }
        }
        
        this.endPass(device);

        // Render waters, furs and translucents
        this.beginPass(viewerInput);
        this.mapInstance.prepareToRenderWaters(device, renderInstManager, viewerInput, this.sceneTexture);
        this.mapInstance.prepareToRenderFurs(device, renderInstManager, viewerInput, this.sceneTexture);
        this.endPass(device);

        for (let drawStep = 1; drawStep < this.mapInstance.getNumDrawSteps(); drawStep++) {
            this.beginPass(viewerInput);
            this.mapInstance.prepareToRender(device, renderInstManager, viewerInput, this.sceneTexture, drawStep);
            this.endPass(device);
        }    
    }
}

export class SFAWorldSceneDesc implements Viewer.SceneDesc {
    constructor(public id: string, private subdir: string, private mapNum: number, public name: string, private gameInfo: GameInfo = SFA_GAME_INFO) {
    }

    public async createScene(device: GfxDevice, context: SceneContext): Promise<Viewer.SceneGfx> {
        console.log(`Creating scene for world ${this.name} (ID ${this.id}) ...`);

        const materialFactory = new MaterialFactory(device);
        const animController = new SFAAnimationController();
        const mapSceneInfo = await loadMap(device, materialFactory, animController, context, this.mapNum, this.gameInfo);
        const mapInstance = new MapInstance(mapSceneInfo);
        await mapInstance.reloadBlocks();

        // Translate map for SFA world coordinates
        const objectOrigin = vec3.fromValues(640 * mapSceneInfo.getOrigin()[0], 0, 640 * mapSceneInfo.getOrigin()[1]);
        const mapMatrix = mat4.create();
        const mapTrans = vec3.clone(objectOrigin);
        vec3.negate(mapTrans, mapTrans);
        mat4.fromTranslation(mapMatrix, mapTrans);
        mapInstance.setMatrix(mapMatrix);

        const pathBase = this.gameInfo.pathBase;
        const dataFetcher = context.dataFetcher;
        const texColl = new SFATextureCollection(this.gameInfo, false);
        await texColl.create(dataFetcher, this.subdir); // TODO: subdirectory depends on map
        const objectMan = new ObjectManager(this.gameInfo, texColl, animController, false);
        const earlyObjectMan = new ObjectManager(SFADEMO_GAME_INFO, texColl, animController, true);
        const envfxMan = new EnvfxManager(this.gameInfo, texColl);
        const [_1, _2, _3, romlistFile, tablesTab_, tablesBin_] = await Promise.all([
            objectMan.create(dataFetcher, this.subdir),
            earlyObjectMan.create(dataFetcher, this.subdir),
            envfxMan.create(dataFetcher),
            dataFetcher.fetchData(`${pathBase}/${this.id}.romlist.zlb`),
            dataFetcher.fetchData(`${pathBase}/TABLES.tab`),
            dataFetcher.fetchData(`${pathBase}/TABLES.bin`),
        ]);
        const romlist = loadRes(romlistFile).createDataView();
        const tablesTab = tablesTab_.createDataView();
        const tablesBin = tablesBin_.createDataView();

        const objectInstances: ObjectInstance[] = [];
        let offs = 0;
        let i = 0;
        while (offs < romlist.byteLength) {
            const fields = {
                objType: romlist.getUint16(offs + 0x0),
                entrySize: romlist.getUint8(offs + 0x2),
                radius: 8 * romlist.getUint8(offs + 0x6),
                pos: vec3.fromValues(
                    romlist.getFloat32(offs + 0x8),
                    romlist.getFloat32(offs + 0xc),
                    romlist.getFloat32(offs + 0x10)
                ),
            };

            const posInMap = vec3.clone(fields.pos);
            vec3.add(posInMap, posInMap, objectOrigin);

            const objParams = dataSubarray(romlist, offs, fields.entrySize * 4);

            const obj = await objectMan.loadObject(device, materialFactory, fields.objType);

            if (obj.objClass === 201) {
                // e.g. sharpclawGr
                obj.yaw = (objParams.getInt8(0x2a) << 8) * Math.PI / 32768;
            } else if (obj.objClass === 222 || obj.objClass === 233 || obj.objClass === 234 || obj.objClass === 235 || obj.objClass === 283 || obj.objClass === 313 || obj.objClass === 424 || obj.objClass === 666) {
                // e.g. setuppoint
                // Do nothing
            } else if (obj.objClass === 237) {
                // e.g. SH_LargeSca
                obj.yaw = (objParams.getInt8(0x1b) << 8) * Math.PI / 32768;
                obj.pitch = (objParams.getInt8(0x22) << 8) * Math.PI / 32768;
                obj.roll = (objParams.getInt8(0x23) << 8) * Math.PI / 32768;
            } else if (obj.objClass === 249) {
                // e.g. ProjectileS
                obj.yaw = (objParams.getInt8(0x1f) << 8) * Math.PI / 32768;
                obj.pitch = (objParams.getInt8(0x1c) << 8) * Math.PI / 32768;
                const objScale = objParams.getUint8(0x1d);
                if (objScale !== 0) {
                    obj.scale *= objScale / 64;
                }
            } else if (obj.objClass === 254) {
                // e.g. MagicPlant
                obj.yaw = (objParams.getInt8(0x1d) << 8) * Math.PI / 32768;
            } else if (obj.objClass === 256) {
                // e.g. TrickyWarp
                obj.yaw = (objParams.getInt8(0x1a) << 8) * Math.PI / 32768;
            } else if (obj.objClass === 240 || obj.objClass === 260 || obj.objClass === 261) {
                // e.g. WarpPoint, SmallBasket, LargeCrate
                obj.yaw = (objParams.getInt8(0x18) << 8) * Math.PI / 32768;
            } else if (obj.objClass === 272) {
                // e.g. SH_Portcull
                obj.yaw = (objParams.getInt8(0x1f) << 8) * Math.PI / 32768;
                const objScale = objParams.getUint8(0x21) / 64;
                if (objScale === 0) {
                    obj.scale = 1.0;
                } else {
                    obj.scale *= objScale;
                }
            } else if (obj.objClass === 275) {
                // e.g. SH_newseqob
                obj.yaw = (objParams.getInt8(0x1c) << 8) * Math.PI / 32768;
            } else if (obj.objClass === 284 || obj.objClass === 289) {
                // e.g. StaffBoulde
                obj.yaw = (objParams.getInt8(0x18) << 8) * Math.PI / 32768;
                // TODO: scale depends on subtype param
            } else if (obj.objClass === 288) {
                // e.g. TrickyGuard
                obj.yaw = (objParams.getInt8(0x19) << 8) * Math.PI / 32768;
            } else if (obj.objClass === 293) {
                // e.g. curve
                obj.yaw = (objParams.getInt8(0x2c) << 8) * Math.PI / 32768;
                obj.pitch = (objParams.getInt8(0x2d) << 8) * Math.PI / 32768;
                // FIXME: mode 8 and 0x1a also have roll at 0x38
            } else if (obj.objClass === 294 && obj.objType === 77) {
                obj.yaw = (objParams.getInt8(0x3d) << 8) * Math.PI / 32768;
                obj.pitch = (objParams.getInt8(0x3e) << 8) * Math.PI / 32768;
            } else if (obj.objClass === 306) {
                // e.g. WaterFallSp
                obj.roll = (objParams.getInt8(0x1a) << 8) * Math.PI / 32768;
                obj.pitch = (objParams.getInt8(0x1b) << 8) * Math.PI / 32768;
                obj.yaw = (objParams.getInt8(0x1c) << 8) * Math.PI / 32768;
            } else if (obj.objClass === 308) {
                // e.g. texscroll2
                const block = mapInstance.getBlockAtPosition(posInMap[0], posInMap[2]);
                if (block === null) {
                    console.warn(`couldn't find block for texscroll object`);
                } else {
                    const scrollableIndex = objParams.getInt16(0x18);
                    const speedX = objParams.getInt8(0x1e);
                    const speedY = objParams.getInt8(0x1f);

                    const tabValue = tablesTab.getUint32(0xe * 4);
                    const targetTexId = tablesBin.getUint32(tabValue * 4 + scrollableIndex * 4) & 0x7fff;
                    // Note: & 0x7fff above is an artifact of how the game stores tex id's.
                    // Bit 15 set means the texture comes directly from TEX1 and does not go through TEXTABLE.

                    const materials = block.getMaterials();
                    for (let i = 0; i < materials.length; i++) {
                        if (materials[i] !== undefined) {
                            const mat = materials[i]!;
                            for (let j = 0; j < mat.shader.layers.length; j++) {
                                const layer = mat.shader.layers[j];
                                if (layer.texId === targetTexId) {
                                    // Found the texture! Make it scroll now.
                                    const theTexture = texColl.getTexture(device, targetTexId, true)!;
                                    const dxPerFrame = (speedX << 16) / theTexture.width;
                                    const dyPerFrame = (speedY << 16) / theTexture.height;
                                    layer.scrollingTexMtx = mat.factory.setupScrollingTexMtx(dxPerFrame, dyPerFrame);
                                    mat.rebuild();
                                }
                            }
                        }
                    }
                }
            } else if (obj.objClass === 346) {
                // e.g. SH_BombWall
                obj.yaw = objParams.getInt16(0x1a) * Math.PI / 32768;
                obj.pitch = objParams.getInt16(0x1c) * Math.PI / 32768;
                obj.roll = objParams.getInt16(0x1e) * Math.PI / 32768;
                let objScale = objParams.getInt8(0x2d);
                if (objScale === 0) {
                    objScale = 20;
                }
                obj.scale *= objScale / 20;
            } else if (obj.objClass === 429) {
                // e.g. ThornTail
                obj.yaw = (objParams.getInt8(0x19) << 8) * Math.PI / 32768;
                obj.scale *= objParams.getUint16(0x1c) / 1000;
            } else if (obj.objClass === 518) {
                // e.g. PoleFlame
                obj.yaw = interpS16((objParams.getUint8(0x18) & 0x3f) << 10) * Math.PI / 32768;
                const objScale = objParams.getInt16(0x1a);
                if (objScale < 1) {
                    obj.scale = 0.1;
                } else {
                    obj.scale = objScale / 8192;
                }
            } else if (obj.objClass === 579) {
                // e.g. DBHoleContr
                obj.yaw = (objParams.getInt8(0x18) << 8) * Math.PI / 32768;
            } else if (obj.objClass === 683) {
                // e.g. LGTProjecte
                obj.yaw = (objParams.getInt8(0x18) << 8) * Math.PI / 32768;
                obj.pitch = (objParams.getInt8(0x19) << 8) * Math.PI / 32768;
                obj.roll = (objParams.getInt8(0x34) << 8) * Math.PI / 32768;
            } else if (obj.objClass === 689) {
                // e.g. CmbSrc
                obj.roll = (objParams.getInt8(0x18) << 8) * Math.PI / 32768;
                obj.pitch = (objParams.getInt8(0x19) << 8) * Math.PI / 32768;
                obj.yaw = (objParams.getInt8(0x1a) << 8) * Math.PI / 32768;
            } else if (obj.objClass === 302 || obj.objClass === 685 || obj.objClass === 687 || obj.objClass === 688) {
                // e.g. Boulder, LongGrassCl
                obj.roll = (objParams.getInt8(0x18) << 8) * Math.PI / 32768;
                obj.pitch = (objParams.getInt8(0x19) << 8) * Math.PI / 32768;
                obj.yaw = (objParams.getInt8(0x1a) << 8) * Math.PI / 32768;
                const scaleParam = objParams.getUint8(0x1b);
                if (scaleParam !== 0) {
                    obj.scale *= scaleParam / 255;
                }
            } else {
                console.log(`Don't know how to setup object class ${obj.objClass} objType ${obj.objType}`);
            }

            objectInstances.push({
                name: obj.name,
                obj: obj,
                pos: fields.pos,
                radius: fields.radius,
                model: obj.models[0],
            });

            console.log(`Object #${i}: ${obj.name} (type ${obj.objType} class ${obj.objClass})`);

            offs += fields.entrySize * 4;
            i++;
        }

        window.main.lookupObject = (objType: number, skipObjindex: boolean = false) => async function() {
            const obj = await objectMan.loadObject(device, materialFactory, objType, skipObjindex);
            console.log(`Object ${objType}: ${obj.name} (type ${obj.objType} class ${obj.objClass})`);
        };

        window.main.lookupEarlyObject = (objType: number, skipObjindex: boolean = false) => async function() {
            const obj = await earlyObjectMan.loadObject(device, materialFactory, objType, skipObjindex);
            console.log(`Object ${objType}: ${obj.name} (type ${obj.objType} class ${obj.objClass})`);
        };

        const envfx = envfxMan.loadEnvfx(device, 60);
        console.log(`Envfx ${envfx.index}: ${JSON.stringify(envfx, null, '\t')}`);

        const testModels = [];
        console.log(`Loading Fox....`);
        testModels.push(await testLoadingAModel(device, dataFetcher, this.gameInfo, this.subdir, 1)); // Fox
        // console.log(`Loading SharpClaw....`);
        // testModels.push(await testLoadingAModel(device, dataFetcher, this.gameInfo, this.subdir, 23)); // Sharpclaw
        // console.log(`Loading General Scales....`);
        // testModels.push(await testLoadingAModel(device, dataFetcher, this.gameInfo, 'shipbattle', 0x140 / 4)); // General Scales
        // console.log(`Loading SharpClaw (demo version)....`);
        // testModels.push(await testLoadingAModel(device, dataFetcher, SFADEMO_GAME_INFO, 'warlock', 0x1394 / 4, ModelVersion.Demo)); // SharpClaw (beta version)
        // console.log(`Loading General Scales (demo version)....`);
        // testModels.push(await testLoadingAModel(device, dataFetcher, SFADEMO_GAME_INFO, 'shipbattle', 0x138 / 4, ModelVersion.Demo)); // General Scales (beta version)
        // console.log(`Loading Beta Fox....`);
        // testModels.push(await testLoadingAModel(device, dataFetcher, SFADEMO_GAME_INFO, 'swapcircle', 0x0 / 4, ModelVersion.Beta)); // Fox (beta version)
        // console.log(`Loading a model (really old version)....`);
        // testModels.push(await testLoadingAModel(device, dataFetcher, SFADEMO_GAME_INFO, 'swapcircle', 0x134 / 4, ModelVersion.Beta));

        const renderer = new WorldRenderer(device, animController, materialFactory, envfxMan, mapInstance, objectInstances, testModels);
        return renderer;
    }
}