
import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";

// ==========================================
// CONFIGURATION
// ==========================================

const MIN_DISTANCE = 2;
const MAX_DISTANCE = 12;
const DEFAULT_DISTANCE = 6;

const ROCK_STABILITY = 100;
const MENU_TOUCH_DISTANCE = 0.055;

const $ = id => document.getElementById(id);

const startButton = $("startButton");
const statusElement = $("status");
const messageElement = $("message");
const planeCountElement = $("planeCount");
const nearestDistanceElement = $("nearestDistance");

// ==========================================
// VARIABLES
// ==========================================

let renderer = null;
let scene = null;
let camera = null;
let session = null;
let referenceSpace = null;

let isRunning = false;
let enabledFeatures = [];

let roomCaptureAttempted = false;
let roomCaptureStatus = "En attente";

let maxDistance = DEFAULT_DISTANCE;

let cameraPassthrough = true;
let armScanEnabled = true;
let distanceScanEnabled = true;

let menuOpen = false;
let rockLostTime = null;
let activeTouch = null;

let latestPlaneCount = 0;
let latestMeshCount = 0;

const planeVisuals = new Map();
const meshVisuals = new Map();

const armVisuals = new Map();

let menuGroup = null;
let menuButtons = [];
let menuRaycaster = new THREE.Raycaster();

// ==========================================
// SHADERS DE DISTANCE
// ==========================================

const vertexShader = `
    varying vec3 vWorldPosition;

    void main() {
        vec4 worldPosition =
            modelMatrix * vec4(position, 1.0);

        vWorldPosition = worldPosition.xyz;

        gl_Position =
            projectionMatrix *
            viewMatrix *
            worldPosition;
    }
`;

const fragmentShader = `
    uniform float uMaxDistance;

    varying vec3 vWorldPosition;

    void main() {
        float d = distance(
            cameraPosition,
            vWorldPosition
        );

        float brightness = clamp(
            1.0 - d / uMaxDistance,
            0.0,
            1.0
        );

        gl_FragColor = vec4(
            vec3(brightness),
            1.0
        );
    }
`;

function createDepthMaterial() {
    return new THREE.ShaderMaterial({
        uniforms: {
            uMaxDistance: {
                value: maxDistance
            }
        },
        vertexShader,
        fragmentShader,
        side: THREE.DoubleSide,
        transparent: false,
        depthTest: true,
        depthWrite: true,
        toneMapped: false
    });
}

function setSensitivity(value) {
    maxDistance = THREE.MathUtils.clamp(
        value,
        MIN_DISTANCE,
        MAX_DISTANCE
    );

    scene?.traverse(object => {
        const material = object.material;

        if (
            material?.uniforms?.uMaxDistance
        ) {
            material.uniforms.uMaxDistance.value =
                maxDistance;
        }
    });

    updateMenu();

    messageElement.textContent =
        `Portée des couleurs : ${maxDistance.toFixed(1)} m`;
}

// ==========================================
// ARTICULATIONS DES MAINS
// ==========================================

function getJointPosition(frame, hand, name) {
    const joint = hand.get(name);

    if (!joint) return null;

    const pose = frame.getJointPose(
        joint,
        referenceSpace
    );

    if (!pose) return null;

    const p = pose.transform.position;

    return new THREE.Vector3(
        p.x,
        p.y,
        p.z
    );
}

function jointDistance(frame, hand, a, b) {
    const p1 = getJointPosition(frame, hand, a);
    const p2 = getJointPosition(frame, hand, b);

    if (!p1 || !p2) return null;

    return p1.distanceTo(p2);
}

// ==========================================
// GESTE ROCK
// ==========================================

function isFingerExtended(frame, hand, wrist, proximal, tip) {
    const base = getJointPosition(frame, hand, proximal);
    const end = getJointPosition(frame, hand, tip);

    if (!base || !end) return false;

    return wrist.distanceTo(end) >
        wrist.distanceTo(base) * 1.15;
}

function isFingerCurled(frame, hand, wrist, proximal, tip) {
    const base = getJointPosition(frame, hand, proximal);
    const end = getJointPosition(frame, hand, tip);

    if (!base || !end) return false;

    return wrist.distanceTo(end) <
        wrist.distanceTo(base) * 1.15;
}

function detectLeftRock(frame) {
    if (!enabledFeatures.includes("hand-tracking")) {
        return null;
    }

    for (const source of session.inputSources) {
        if (!source.hand || source.handedness !== "left") {
            continue;
        }

        const hand = source.hand;

        const wrist = getJointPosition(
            frame,
            hand,
            "wrist"
        );

        if (!wrist) continue;

        const index = isFingerExtended(
            frame, hand, wrist,
            "index-finger-phalanx-proximal",
            "index-finger-tip"
        );

        const middle = isFingerCurled(
            frame, hand, wrist,
            "middle-finger-phalanx-proximal",
            "middle-finger-tip"
        );

        const ring = isFingerCurled(
            frame, hand, wrist,
            "ring-finger-phalanx-proximal",
            "ring-finger-tip"
        );

        const pinky = isFingerExtended(
            frame, hand, wrist,
            "pinky-finger-phalanx-proximal",
            "pinky-finger-tip"
        );

        if (index && middle && ring && pinky) {
            return {
                source,
                wrist
            };
        }
    }

    return null;
}

// ==========================================
// MENU 3D
// ==========================================

const MENU_WIDTH = 0.62;
const MENU_HEIGHT = 0.66;

function createTextTexture(title, subtitle = "") {
    const canvas = document.createElement("canvas");

    canvas.width = 768;
    canvas.height = 180;

    const ctx = canvas.getContext("2d");

    ctx.fillStyle = "#101b2b";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.strokeStyle = "#47718d";
    ctx.lineWidth = 4;
    ctx.strokeRect(3, 3, canvas.width - 6, canvas.height - 6);

    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 38px Arial";
    ctx.textAlign = "left";
    ctx.fillText(title, 30, 76);

    if (subtitle) {
        ctx.fillStyle = "#a9c4dc";
        ctx.font = "25px Arial";
        ctx.fillText(subtitle, 30, 125);
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;

    return texture;
}

function createMenuButton(label, subtitle, action, y) {
    const geometry = new THREE.PlaneGeometry(
        0.53,
        0.085
    );

    const material = new THREE.MeshBasicMaterial({
        map: createTextTexture(label, subtitle),
        transparent: false,
        side: THREE.DoubleSide
    });

    const button = new THREE.Mesh(
        geometry,
        material
    );

    button.position.set(0, y, 0.012);

    button.userData.action = action;

    menuGroup.add(button);
    menuButtons.push(button);

    return button;
}

function createMenu() {
    if (menuGroup) return;

    menuGroup = new THREE.Group();

    const background = new THREE.Mesh(
        new THREE.PlaneGeometry(
            MENU_WIDTH,
            MENU_HEIGHT
        ),
        new THREE.MeshBasicMaterial({
            color: 0x071321,
            transparent: true,
            opacity: 0.96,
            side: THREE.DoubleSide
        })
    );

    menuGroup.add(background);

    const titleCanvas = document.createElement("canvas");
    titleCanvas.width = 768;
    titleCanvas.height = 130;

    const ctx = titleCanvas.getContext("2d");

    ctx.fillStyle = "#5cf0c0";
    ctx.font = "bold 54px Arial";
    ctx.fillText("QUEST SCANNER", 25, 72);

    const titleTexture = new THREE.CanvasTexture(titleCanvas);
    titleTexture.colorSpace = THREE.SRGBColorSpace;

    const title = new THREE.Mesh(
        new THREE.PlaneGeometry(0.53, 0.09),
        new THREE.MeshBasicMaterial({
            map: titleTexture,
            transparent: true,
            side: THREE.DoubleSide
        })
    );

    title.position.set(0, 0.27, 0.012);
    menuGroup.add(title);

    createMenuButton(
        "SENSIBILITE",
        "Touchez pour regler la portee",
        "sensitivity",
        0.16
    );

    createMenuButton(
        "ACTUALISER LE SCAN",
        "Demander une nouvelle capture Meta",
        "rescan",
        0.055
    );

    createMenuButton(
        "CAMERA TRANSPARENTE",
        "Activer ou masquer le passthrough",
        "camera",
        -0.05
    );

    createMenuButton(
        "ESTIMATION MAINS / BRAS",
        "Afficher ou masquer les formes estimees",
        "arms",
        -0.155
    );

    createMenuButton(
        "SCAN DES DISTANCES",
        "Afficher ou masquer les distances",
        "distance",
        -0.26
    );

    // Curseur de sensibilité
    const sliderBackground = new THREE.Mesh(
        new THREE.PlaneGeometry(0.47, 0.018),
        new THREE.MeshBasicMaterial({
            color: 0x30465d,
            side: THREE.DoubleSide
        })
    );

    sliderBackground.position.set(
        0,
        0.105,
        0.025
    );

    menuGroup.add(sliderBackground);

    const sliderFill = new THREE.Mesh(
        new THREE.PlaneGeometry(0.01, 0.018),
        new THREE.MeshBasicMaterial({
            color: 0x5cf0c0,
            side: THREE.DoubleSide
        })
    );

    sliderFill.position.set(
        -0.235,
        0.105,
        0.03
    );

    sliderFill.userData.isSlider = true;

    menuGroup.add(sliderFill);

    menuGroup.userData.sliderFill = sliderFill;

    scene.add(menuGroup);

    menuGroup.visible = false;

    updateMenu();
}

function updateMenu() {
    if (!menuGroup) return;

    const sensitivityPercent = Math.round(
        ((MAX_DISTANCE - maxDistance) /
        (MAX_DISTANCE - MIN_DISTANCE)) * 100
    );

    const slider = menuGroup.userData.sliderFill;

    if (slider) {
        const ratio =
            (maxDistance - MIN_DISTANCE) /
            (MAX_DISTANCE - MIN_DISTANCE);

        slider.scale.x = Math.max(0.01, ratio * 47);

        slider.position.x =
            -0.235 + ratio * 0.235;
    }

    const labels = {
        camera: cameraPassthrough ? "CAMERA : ON" : "CAMERA : OFF",
        arms: armScanEnabled ? "MAINS / BRAS : ON" : "MAINS / BRAS : OFF",
        distance: distanceScanEnabled ? "DISTANCES : ON" : "DISTANCES : OFF"
    };

    menuButtons.forEach(button => {
        const action = button.userData.action;

        if (labels[action]) {
            button.material.map.dispose();
            button.material.map = createTextTexture(
                labels[action],
                action === "camera"
                    ? "Transparence du fond"
                    : "Touchez pour modifier"
            );

            button.material.needsUpdate = true;
        }

        if (action === "sensitivity") {
            button.material.map.dispose();
            button.material.map = createTextTexture(
                `SENSIBILITE : ${sensitivityPercent}%`,
                `Portee actuelle : ${maxDistance.toFixed(1)} metres`
            );

            button.material.needsUpdate = true;
        }
    });
}

// ==========================================
// POSITION DU MENU
// ==========================================

function updateMenuPosition(frame, viewerPose, rock) {
    if (!menuGroup || !rock) return;

    const headQuaternion = new THREE.Quaternion();

    const headRotation = viewerPose.transform.orientation;

    headQuaternion.set(
        headRotation.x,
        headRotation.y,
        headRotation.z,
        headRotation.w
    );

    const offset = new THREE.Vector3(
        0.32,
        0.20,
        -0.42
    ).applyQuaternion(headQuaternion);

    menuGroup.position.copy(
        rock.wrist.clone().add(offset)
    );

    menuGroup.quaternion.copy(headQuaternion);
    menuGroup.visible = true;
}

function closeMenu() {
    if (menuGroup) {
        menuGroup.visible = false;
    }

    menuOpen = false;
    activeTouch = null;
}

// ==========================================
// TOUCHER LES BOUTONS
// ==========================================

function getIndexTip(frame, source) {
    if (!source.hand) return null;

    return getJointPosition(
        frame,
        source.hand,
        "index-finger-tip"
    );
}

function getMenuTouch(frame) {
    if (!menuGroup || !menuGroup.visible) return null;

    const sources = Array.from(session.inputSources)
        .filter(source =>
            source.hand &&
            source.handedness !== "left"
        );

    const inverse = menuGroup.matrixWorld.clone().invert();

    for (const source of sources) {
        const tip = getIndexTip(frame, source);

        if (!tip) continue;

        const local = tip.clone().applyMatrix4(inverse);

        if (
            Math.abs(local.z) > MENU_TOUCH_DISTANCE ||
            Math.abs(local.x) > 0.29 ||
            local.y > 0.22 ||
            local.y < -0.31
        ) {
            continue;
        }

        return {
            source,
            local,
            world: tip
        };
    }

    return null;
}

function activateMenuAction(action) {
    switch (action) {
        case "rescan":
            initiateRoomCapture();
            break;

        case "camera":
            cameraPassthrough = !cameraPassthrough;

            if (renderer) {
                renderer.setClearColor(
                    0x000000,
                    cameraPassthrough ? 0 : 1
                );

                renderer.setClearAlpha(
                    cameraPassthrough ? 0 : 1
                );
            }

            updateMenu();

            messageElement.textContent =
                cameraPassthrough
                    ? "Passthrough transparent activé."
                    : "Fond opaque activé.";

            break;

        case "arms":
            armScanEnabled = !armScanEnabled;
            updateMenu();

            messageElement.textContent =
                armScanEnabled
                    ? "Estimation des mains et bras activée."
                    : "Estimation des mains et bras désactivée.";

            break;

        case "distance":
            distanceScanEnabled = !distanceScanEnabled;
            updateMenu();

            updateScanVisibility();

            messageElement.textContent =
                distanceScanEnabled
                    ? "Scan des distances activé."
                    : "Scan des distances désactivé.";

            break;
    }
}

function updateMenuTouch(frame) {
    if (!menuOpen || !menuGroup?.visible) return;

    const touch = getMenuTouch(frame);

    if (!touch) {
        activeTouch = null;
        return;
    }

    const x = touch.local.x;
    const y = touch.local.y;

    // Curseur de sensibilité
    if (y > 0.09 && y < 0.12 && Math.abs(x) < 0.25) {
        const ratio = THREE.MathUtils.clamp(
            (x + 0.235) / 0.47,
            0,
            1
        );

        setSensitivity(
            MAX_DISTANCE -
            ratio * (MAX_DISTANCE - MIN_DISTANCE)
        );

        activeTouch = "sensitivity";
        return;
    }

    let touched = null;

    for (const button of menuButtons) {
        const position = button.position;

        if (
            Math.abs(x - position.x) < 0.265 &&
            Math.abs(y - position.y) < 0.043
        ) {
            touched = button.userData.action;
            break;
        }
    }

    if (!touched) {
        activeTouch = null;
        return;
    }

    if (activeTouch !== touched) {
        activeTouch = touched;
        activateMenuAction(touched);
    }
}

// ==========================================
// GESTION DU MENU PAR LE GESTE ROCK
// ==========================================

function updateRockMenu(frame, viewerPose, time) {
    if (!enabledFeatures.includes("hand-tracking")) {
        closeMenu();
        return;
    }

    const rock = detectLeftRock(frame);

    if (rock) {
        rockLostTime = null;

        if (!menuOpen) {
            menuOpen = true;

            if (!menuGroup) {
                createMenu();
            }

            menuGroup.visible = true;

            statusElement.textContent = "Menu de contrôle ouvert";
        }

        updateMenuPosition(frame, viewerPose, rock);
        updateMenuTouch(frame);

        return;
    }

    if (menuOpen) {
        if (rockLostTime === null) {
            rockLostTime = time;
        }

        // Petite tolérance pour éviter les fermetures
        // causées par une image de tracking manquante.
        if (time - rockLostTime > ROCK_STABILITY) {
            closeMenu();

            statusElement.textContent = "Scanner actif";
            messageElement.textContent =
                "Menu fermé. Refais le geste Rock avec la main gauche.";
        }
    }
}

// ==========================================
// VISIBILITÉ DU SCAN
// ==========================================

function updateScanVisibility() {
    for (const visual of planeVisuals.values()) {
        visual.group.visible = distanceScanEnabled;
    }

    for (const visual of meshVisuals.values()) {
        visual.group.visible = distanceScanEnabled;
    }
}

// ==========================================
// GÉOMÉTRIE DES PLANS
// ==========================================

function createPlaneGeometry(polygon) {
    const positions = [];

    for (const point of polygon) {
        positions.push(point.x, point.y, point.z);
    }

    const indices = [];

    for (let i = 1; i < polygon.length - 1; i++) {
        indices.push(0, i, i + 1);
    }

    const geometry = new THREE.BufferGeometry();

    geometry.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(positions, 3)
    );

    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();

    return geometry;
}

function getPolygonSignature(polygon) {
    return polygon.map(point =>
        `${point.x.toFixed(4)},${point.y.toFixed(4)},${point.z.toFixed(4)}`
    ).join(";");
}

function createPlaneVisual(plane) {
    const group = new THREE.Group();

    const mesh = new THREE.Mesh(
        createPlaneGeometry(plane.polygon),
        createDepthMaterial()
    );

    group.add(mesh);
    group.matrixAutoUpdate = false;

    scene.add(group);

    return {
        group,
        mesh,
        signature: getPolygonSignature(plane.polygon)
    };
}

function updatePlane(plane, frame) {
    if (!plane.polygon || plane.polygon.length < 3) {
        return null;
    }

    const pose = frame.getPose(
        plane.planeSpace,
        referenceSpace
    );

    if (!pose) return null;

    let visual = planeVisuals.get(plane);

    if (!visual) {
        visual = createPlaneVisual(plane);
        planeVisuals.set(plane, visual);
    }

    const signature = getPolygonSignature(plane.polygon);

    if (signature !== visual.signature) {
        visual.mesh.geometry.dispose();

        visual.mesh.geometry =
            createPlaneGeometry(plane.polygon);

        visual.signature = signature;
    }

    visual.group.matrix.fromArray(pose.transform.matrix);
    visual.group.matrixWorldNeedsUpdate = true;
    visual.group.visible = distanceScanEnabled;

    return getWorldCenter(visual);
}

// ==========================================
// MAILLAGES 3D
// ==========================================

function createMeshVisual() {
    const group = new THREE.Group();

    const mesh = new THREE.Mesh(
        new THREE.BufferGeometry(),
        createDepthMaterial()
    );

    group.add(mesh);
    group.matrixAutoUpdate = false;

    scene.add(group);

    return {
        group,
        mesh,
        lastChangedTime: null,
        vertexCount: 0,
        indexCount: 0
    };
}

function updateMeshGeometry(visual, xrMesh) {
    const vertices = xrMesh.vertices;
    const indices = xrMesh.indices;

    if (
        !vertices ||
        vertices.length < 9 ||
        !indices ||
        indices.length < 3
    ) {
        return false;
    }

    const changedTime = xrMesh.lastChangedTime;

    const vertexCount = vertices.length;
    const indexCount = indices.length;

    const geometryChanged =
        changedTime !== visual.lastChangedTime ||
        vertexCount !== visual.vertexCount ||
        indexCount !== visual.indexCount;

    if (!geometryChanged && visual.vertexCount > 0) {
        return true;
    }

    const geometry = new THREE.BufferGeometry();

    geometry.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(
            Array.from(vertices),
            3
        )
    );

    geometry.setIndex(Array.from(indices));

    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();

    visual.mesh.geometry.dispose();
    visual.mesh.geometry = geometry;

    visual.lastChangedTime = changedTime ?? null;
    visual.vertexCount = vertexCount;
    visual.indexCount = indexCount;

    return true;
}

function updateDetectedMesh(xrMesh, frame) {
    if (!xrMesh.meshSpace) return null;

    const pose = frame.getPose(
        xrMesh.meshSpace,
        referenceSpace
    );

    if (!pose) return null;

    let visual = meshVisuals.get(xrMesh);

    if (!visual) {
        visual = createMeshVisual();
        meshVisuals.set(xrMesh, visual);
    }

    if (!updateMeshGeometry(visual, xrMesh)) {
        return null;
    }

    visual.group.matrix.fromArray(pose.transform.matrix);
    visual.group.matrixWorldNeedsUpdate = true;
    visual.group.visible = distanceScanEnabled;

    return getWorldCenter(visual);
}

function getWorldCenter(visual) {
    const sphere = visual.mesh.geometry.boundingSphere;

    if (!sphere) return null;

    return sphere.center.clone().applyMatrix4(
        visual.group.matrix
    );
}

// ==========================================
// ESTIMATION DES MAINS ET DES BRAS
// ==========================================

function createArmMaterial() {
    return createDepthMaterial();
}

function createSegment() {
    const mesh = new THREE.Mesh(
        new THREE.CylinderGeometry(
            0.018,
            0.025,
            1,
            8
        ),
        createArmMaterial()
    );

    scene.add(mesh);

    return mesh;
}

function updateSegment(mesh, start, end) {
    const direction = new THREE.Vector3()
        .subVectors(end, start);

    const length = direction.length();

    if (length < 0.001) {
        mesh.visible = false;
        return;
    }

    mesh.visible = true;
    mesh.position.copy(start).add(end).multiplyScalar(0.5);

    mesh.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        direction.normalize()
    );

    mesh.scale.set(1, length, 1);
}

function createJointSphere(radius = 0.018) {
    const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(radius, 8, 8),
        createArmMaterial()
    );

    scene.add(mesh);
    return mesh;
}

const fingerChains = [
    [
        "thumb-metacarpal",
        "thumb-phalanx-proximal",
        "thumb-phalanx-distal",
        "thumb-tip"
    ],
    [
        "index-finger-metacarpal",
        "index-finger-phalanx-proximal",
        "index-finger-phalanx-intermediate",
        "index-finger-phalanx-distal",
        "index-finger-tip"
    ],
    [
        "middle-finger-metacarpal",
        "middle-finger-phalanx-proximal",
        "middle-finger-phalanx-intermediate",
        "middle-finger-phalanx-distal",
        "middle-finger-tip"
    ],
    [
        "ring-finger-metacarpal",
        "ring-finger-phalanx-proximal",
        "ring-finger-phalanx-intermediate",
        "ring-finger-phalanx-distal",
        "ring-finger-tip"
    ],
    [
        "pinky-finger-metacarpal",
        "pinky-finger-phalanx-proximal",
        "pinky-finger-phalanx-intermediate",
        "pinky-finger-phalanx-distal",
        "pinky-finger-tip"
    ]
];

function createHandVisual() {
    return {
        arm: createSegment(),
        elbow: createJointSphere(0.025),
        wrist: createJointSphere(0.035),
        hand: createJointSphere(0.045),
        fingerSegments: [],
        fingerJoints: []
    };
}

function ensureFingerVisuals(visual) {
    if (visual.fingerSegments.length > 0) return;

    for (const chain of fingerChains) {
        const segments = [];
        const joints = [];

        for (let i = 1; i < chain.length; i++) {
            segments.push(createSegment());
            joints.push(createJointSphere(0.009));
        }

        visual.fingerSegments.push(segments);
        visual.fingerJoints.push(joints);
    }
}

function updateHandArm(source, frame, viewerPosition) {
    if (!source.hand) return;

    const key = source.handedness;

    let visual = armVisuals.get(key);

    if (!visual) {
        visual = createHandVisual();
        armVisuals.set(key, visual);
    }

    ensureFingerVisuals(visual);

    const hand = source.hand;

    const wrist = getJointPosition(frame, hand, "wrist");

    if (!wrist) {
        visual.arm.visible = false;
        return;
    }

    // Estimation des épaules depuis la position du casque.
    const shoulder = viewerPosition.clone();

    shoulder.x += key === "left" ? -0.19 : 0.19;
    shoulder.y -= 0.24;
    shoulder.z -= 0.06;

    // Coude estimé entre épaule et poignet.
    const elbow = shoulder.clone().lerp(wrist, 0.53);

    elbow.y -= 0.035;
    elbow.x += key === "left" ? -0.035 : 0.035;

    updateSegment(visual.arm, elbow, wrist);

    visual.elbow.position.copy(elbow);
    visual.wrist.position.copy(wrist);
    visual.hand.position.copy(wrist);

    const palm = getJointPosition(
        frame,
        hand,
        "middle-finger-metacarpal"
    );

    if (palm) {
        visual.hand.position.lerp(palm, 0.5);
    }

    const show = armScanEnabled;

    visual.arm.visible = show;
    visual.elbow.visible = show;
    visual.wrist.visible = show;
    visual.hand.visible = show;

    for (let f = 0; f < fingerChains.length; f++) {
        const chain = fingerChains[f];

        for (let j = 1; j < chain.length; j++) {
            const a = getJointPosition(
                frame,
                hand,
                chain[j - 1]
            );

            const b = getJointPosition(
                frame,
                hand,
                chain[j]
            );

            const segment = visual.fingerSegments[f][j - 1];
            const joint = visual.fingerJoints[f][j - 1];

            if (a && b) {
                updateSegment(segment, a, b);
                joint.position.copy(b);

                segment.visible = show;
                joint.visible = show;
            } else {
                segment.visible = false;
                joint.visible = false;
            }
        }
    }
}

function updateArms(frame, viewerPosition) {
    if (!enabledFeatures.includes("hand-tracking")) return;

    const seen = new Set();

    for (const source of session.inputSources) {
        if (!source.hand) continue;

        seen.add(source.handedness);

        updateHandArm(
            source,
            frame,
            viewerPosition
        );
    }

    for (const [key, visual] of armVisuals) {
        if (!seen.has(key)) {
            visual.arm.visible = false;
            visual.elbow.visible = false;
            visual.wrist.visible = false;
            visual.hand.visible = false;

            visual.fingerSegments.flat().forEach(mesh => {
                mesh.visible = false;
            });

            visual.fingerJoints.flat().forEach(mesh => {
                mesh.visible = false;
            });
        }
    }
}

// ==========================================
// ROOM CAPTURE
// ==========================================

async function initiateRoomCapture() {
    if (!session || !isRunning) return;

    if (roomCaptureAttempted) {
        messageElement.textContent =
            "Une capture a déjà été demandée dans cette session. Une nouvelle session peut être nécessaire pour recommencer.";

        return;
    }

    if (typeof session.initiateRoomCapture !== "function") {
        roomCaptureStatus = "API indisponible.";

        messageElement.textContent =
            "La capture de pièce n'est pas disponible dans cette session.";

        return;
    }

    roomCaptureAttempted = true;

    roomCaptureStatus = "Demande envoyée.";

    messageElement.textContent =
        "Demande de mise à jour du scan envoyée à Meta.";

    try {
        const result = session.initiateRoomCapture();

        if (result?.then) {
            await result;
        }

        roomCaptureStatus = "Demande envoyée.";

        messageElement.textContent =
            "Termine la capture dans l'interface Meta si elle apparaît.";

    } catch (error) {
        roomCaptureStatus = "Erreur : " + error.message;
        messageElement.textContent = roomCaptureStatus;
        console.error(error);
    }
}

// ==========================================
// DÉMARRAGE
// ==========================================

async function enterAR() {
    startButton.disabled = true;

    messageElement.textContent =
        "Initialisation du scanner...";

    roomCaptureAttempted = false;
    roomCaptureStatus = "En attente";

    maxDistance = DEFAULT_DISTANCE;

    menuOpen = false;
    rockLostTime = null;
    activeTouch = null;

    try {
        session = await navigator.xr.requestSession(
            "immersive-ar",
            {
                requiredFeatures: [
                    "local-floor",
                    "plane-detection"
                ],
                optionalFeatures: [
                    "unbounded",
                    "mesh-detection",
                    "hand-tracking"
                ]
            }
        );

        enabledFeatures = Array.from(
            session.enabledFeatures || []
        );

        const referenceType =
            enabledFeatures.includes("unbounded")
                ? "unbounded"
                : "local-floor";

        if (!renderer) {
            renderer = new THREE.WebGLRenderer({
                alpha: true,
                antialias: true,
                powerPreference: "high-performance"
            });

            renderer.setPixelRatio(
                Math.min(window.devicePixelRatio, 1.5)
            );

            renderer.setSize(
                window.innerWidth,
                window.innerHeight
            );

            renderer.xr.enabled = true;

            renderer.domElement.style.position = "fixed";
            renderer.domElement.style.inset = "0";
            renderer.domElement.style.width = "100vw";
            renderer.domElement.style.height = "100vh";
            renderer.domElement.style.zIndex = "9999";

            document.body.appendChild(renderer.domElement);

            scene = new THREE.Scene();
            scene.background = null;

            camera = new THREE.PerspectiveCamera(
                70,
                window.innerWidth / window.innerHeight,
                0.01,
                100
            );
        }

        renderer.xr.setReferenceSpaceType(referenceType);

        // Le passthrough est affiché grâce à la transparence.
        renderer.setClearColor(
            0x000000,
            cameraPassthrough ? 0 : 1
        );

        renderer.setClearAlpha(
            cameraPassthrough ? 0 : 1
        );

        await renderer.xr.setSession(session);

        referenceSpace = renderer.xr.getReferenceSpace();

        if (!referenceSpace) {
            throw new Error(
                "Impossible d'obtenir l'espace spatial."
            );
        }

        document.body.classList.add("xr-active");

        isRunning = true;

        statusElement.textContent = "Scanner actif";

        console.info("Fonctionnalités WebXR :", enabledFeatures);

        messageElement.textContent =
            enabledFeatures.includes("hand-tracking")
                ? "Fais le geste Rock avec ta main gauche pour ouvrir le menu."
                : "Hand Tracking indisponible. Vérifie les fonctionnalités WebXR.";

        session.addEventListener("end", stopAR, {
            once: true
        });

        renderer.setAnimationLoop(renderFrame);

    } catch (error) {
        console.error(error);

        messageElement.textContent =
            "Erreur : " + error.message;

        if (session) {
            try {
                await session.end();
            } catch (_) {}
        }

        if (renderer) {
            renderer.setAnimationLoop(null);
            renderer.dispose();
            renderer.domElement.remove();
            renderer = null;
        }

        if (scene) {
            disposeScene();
        }

        startButton.disabled = false;
    }
}

// ==========================================
// BOUCLE DE RENDU
// ==========================================

function renderFrame(time, frame) {
    if (!isRunning || !frame || !referenceSpace) {
        return;
    }

    const viewerPose = frame.getViewerPose(referenceSpace);

    if (!viewerPose) return;

    const viewerPosition = new THREE.Vector3(
        viewerPose.transform.position.x,
        viewerPose.transform.position.y,
        viewerPose.transform.position.z
    );

    updateRockMenu(
        frame,
        viewerPose,
        time
    );

    updateArms(
        frame,
        viewerPosition
    );

    const planes = frame.detectedPlanes
        ? Array.from(frame.detectedPlanes)
        : [];

    const meshes = frame.detectedMeshes
        ? Array.from(frame.detectedMeshes)
        : [];

    latestPlaneCount = planes.length;
    latestMeshCount = meshes.length;

    let nearestDistance = Infinity;

    for (const plane of planes) {
        const center = updatePlane(plane, frame);

        if (center && distanceScanEnabled) {
            nearestDistance = Math.min(
                nearestDistance,
                viewerPosition.distanceTo(center)
            );
        }
    }

    for (const xrMesh of meshes) {
        const center = updateDetectedMesh(xrMesh, frame);

        if (center && distanceScanEnabled) {
            nearestDistance = Math.min(
                nearestDistance,
                viewerPosition.distanceTo(center)
            );
        }
    }

    planeCountElement.textContent =
        planeVisuals.size + meshVisuals.size;

    nearestDistanceElement.textContent =
        distanceScanEnabled && Number.isFinite(nearestDistance)
            ? nearestDistance.toFixed(2)
            : "—";

    renderer.render(scene, camera);
}

// ==========================================
// NETTOYAGE
// ==========================================

function disposeScene() {
    if (!scene) return;

    scene.traverse(object => {
        if (object.geometry) {
            object.geometry.dispose();
        }

        if (object.material) {
            const materials = Array.isArray(object.material)
                ? object.material
                : [object.material];

            for (const material of materials) {
                if (material.map) {
                    material.map.dispose();
                }

                material.dispose();
            }
        }
    });

    planeVisuals.clear();
    meshVisuals.clear();
    armVisuals.clear();
    menuButtons = [];
    menuGroup = null;

    scene.clear();
    scene = null;
}

// ==========================================
// ARRÊT
// ==========================================

function stopAR() {
    isRunning = false;

    const report =
        `Room Capture : ${roomCaptureStatus}\n` +
        `Plans : ${planeVisuals.size}\n` +
        `Maillages : ${meshVisuals.size}\n` +
        `Portée : ${maxDistance.toFixed(1)} m\n` +
        `Fonctionnalités : ${enabledFeatures.join(", ") || "non communiquées"}`;

    console.info("RAPPORT FINAL DU SCAN\n" + report);

    if (renderer) {
        renderer.setAnimationLoop(null);
    }

    disposeScene();

    if (renderer) {
        renderer.dispose();
        renderer.domElement.remove();
        renderer = null;
    }

    camera = null;
    session = null;
    referenceSpace = null;

    document.body.classList.remove("xr-active");

    startButton.disabled = false;

    statusElement.textContent = "Scan terminé";
    messageElement.textContent = report;

    planeCountElement.textContent = "0";
    nearestDistanceElement.textContent = "—";
}

// ==========================================
// REDIMENSIONNEMENT
// ==========================================

window.addEventListener("resize", () => {
    if (!renderer || !camera) return;

    camera.aspect =
        window.innerWidth / window.innerHeight;

    camera.updateProjectionMatrix();

    renderer.setSize(
        window.innerWidth,
        window.innerHeight
    );
});

// ==========================================
// INITIALISATION
// ==========================================

startButton.addEventListener("click", enterAR);

checkSupport();

async function checkSupport() {
    if (!navigator.xr) {
        statusElement.textContent = "WebXR indisponible";

        messageElement.textContent =
            "Ouvre le site dans Meta Quest Browser.";

        return;
    }

    try {
        const supported =
            await navigator.xr.isSessionSupported("immersive-ar");

        if (!supported) {
            throw new Error("Mode immersive-ar indisponible.");
        }

        statusElement.textContent = "WebXR détecté";
        messageElement.textContent = "Scanner prêt.";

        startButton.disabled = false;

    } catch (error) {
        statusElement.textContent = "Non compatible";
        messageElement.textContent = error.message;
    }
}
