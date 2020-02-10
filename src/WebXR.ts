export function IsWebXRSupported() {
    if (!!window.navigator.xr) {
        return navigator.xr.isSessionSupported('immersive-vr');
    }
    return false;
}

// TODO fordacious: webxr manager which controls webxr state on init and destroy

export class WebXRContext {
    public xrSession: XrSession;
    public xrViewSpace: XrReferenceSpace;
    public xrLocalSpace: XrReferenceSpace;

    public renderingContext: WebGLRenderingContext;
    public views: XrView[];

    public onRender: ()=>void;

    public viewerPose: XrPose;

    // TODO fordacious: need rendering context to pass to rendering system
    constructor(private gl: WebGLRenderingContext ) {
        this.renderingContext = gl;
    }

    public start() {
        var _this = this;
        navigator.xr.requestSession('immersive-vr', {
            requiredFeatures: [],
            optionalFeatures: ['viewer', 'local-floor']
        }).then((xrSession: XrSession) => {
            let glLayer = new XRWebGLLayer(xrSession, this.renderingContext);
            xrSession.updateRenderState({ baseLayer: glLayer });
            
            xrSession.requestReferenceSpace('viewer').then((refSpace: XrReferenceSpace) => {
                this.xrViewSpace = refSpace;
                
                xrSession.requestReferenceSpace('local-floor').then((refSpace: XrReferenceSpace) => {
                    this.xrLocalSpace = refSpace;
                    xrSession.requestAnimationFrame(this.onXRFrame.bind(_this));
                    this.xrSession = xrSession;
                });
            });
        });
    }

    public isRunning() {
        return !!this.xrSession;
    }

    // TODO fordacious: race condition
    public end() {
        if (this.xrSession) {
            this.xrSession.end();
        }
        this.xrSession = null;
    }

    private onXRFrame(time, frame: XrFrame) {
        let session = frame.session;
        let pose = frame.getViewerPose(this.xrLocalSpace);

        if (pose) {
            this.views = pose.views;
        }

        this.viewerPose = frame.getPose(this.xrViewSpace, this.xrLocalSpace);

        this.onRender();

        session.requestAnimationFrame(this.onXRFrame.bind(this));
      }
}