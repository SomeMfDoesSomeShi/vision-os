
import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";

// ======================================================
// CONFIGURATION
// ======================================================

const MIN_DISTANCE = 2;
const MAX_DISTANCE = 12;
const DEFAULT_DISTANCE = 6;

const MENU_INTERACTION_DELAY = 1500;

const PINCH_START_DISTANCE = 0.032;
const PINCH_RELEASE_DISTANCE = 0.055;

const SMOOTHING = 0.32;

const MENU_WIDTH = 0.62;
const MENU_HEIGHT = 0.66;

const UPPER_ARM_LENGTH = 0.34;
const FOREARM_LENGTH = 0.30;

const SHOULDER_SIDE_OFFSET = 0.19;
const SHOULDER_DOWN_OFFSET = 0.16;

const $ = id => document.getElementById(id);

const startButton = $("startButton");
const statusElement = $("status");
const messageElement = $("message");
const planeCountElement = $("planeCount");
const nearestDistanceElement = $("nearestDistance");

// ======================================================
// VARIABLES
// ======================================================

let renderer = null;
let scene = null;
let camera = null;
let session = null;
let referenceSpace = null;

let isRunning = false;
let enabledFeatures = [];

let maxDistance = DEFAULT_DISTANCE;

let armScanEnabled = true;
let distanceScanEnabled = true;

let menuOpen = false;
let menuInteractionUnlockTime = 0;

let pinchWasActive = false;
let pinchActive = false;
let activeTouch = null;

let menuGroup = null;
let menuButtons = [];
let closeButton = null;

let roomCaptureAttempted = false;
let roomCaptureStatus = "En attente";

const planeVisuals = new Map();
const meshVisuals = new Map();
const armVisuals = new Map();

// ======================================================
// SHADER DE PROFONDEUR ORIGINAL
// ======================================================

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

        if (material?.uniforms?.uMaxDistance) {
            material.uniforms.uMaxDistance.value =
                maxDistance;
        }
    });

    updateMenu();

    messageElement.textContent =
        `Portée du scan : ${maxDistance.toFixed(1)} m`;
}

// ======================================================
// UTILITAIRES MAINS
// ======================================================

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

function getHand(frame, handedness) {
    if (!session) return null;

    return Array.from(session.inputSources).find(
        source =>
            source.hand &&
            source.handedness === handedness
    ) || null;
}

// ======================================================
// GESTE ROCK
// ======================================================

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
    const source = getHand(frame, "left");

    if (!source) return false;

    const hand = source.hand;

    const wrist = getJointPosition(
        frame,
        hand,
        "wrist"
    );

    if (!wrist) return false;

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

    return index && middle && ring && pinky;
}

// ======================================================
// TEXTURES
// ======================================================

function createTextTexture(title, subtitle = "", selected = false) {
    const canvas = document.createElement("canvas");

    canvas.width = 768;
    canvas.height = 180;

    const ctx = canvas.getContext("2d");

    ctx.fillStyle = selected ? "#174c53" : "#101b2b";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.strokeStyle = selected ? "#72ffe0" : "#38566e";
    ctx.lineWidth = selected ? 8 : 4;

    ctx.strokeRect(
        4,
        4,
        canvas.width - 8,
        canvas.height - 8
    );

    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 38px Arial";
    ctx.textAlign = "left";
    ctx.fillText(title, 30, 76);

    ctx.fillStyle = "#b6cddd";
    ctx.font = "25px Arial";
    ctx.fillText(subtitle, 30, 125);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;

    return texture;
}

function createMenuMaterial(texture) {
    return new THREE.MeshBasicMaterial({
        map: texture,
        side: THREE.DoubleSide,
        depthTest: false,
        depthWrite: false
    });
}

// ======================================================
// BOUTONS
// ======================================================

function createMenuButton(label, subtitle, action, y) {
    const button = new THREE.Mesh(
        new THREE.PlaneGeometry(0.53, 0.085),
        createMenuMaterial(
            createTextTexture(label, subtitle)
        )
    );

    button.position.set(0, y, 0.025);

    button.userData.action = action;
    button.userData.defaultTitle = label;
    button.userData.subtitle = subtitle;
    button.userData.selected = false;

    menuGroup.add(button);
    menuButtons.push(button);

    return button;
}

function createCloseButton() {
    const canvas = document.createElement("canvas");

    canvas.width = 256;
    canvas.height = 256;

    const ctx = canvas.getContext("2d");

    ctx.fillStyle = "#a52c3b";
    ctx.beginPath();
    ctx.arc(128, 128, 112, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 18;
    ctx.lineCap = "round";

    ctx.beginPath();
    ctx.moveTo(83, 83);
    ctx.lineTo(173, 173);
    ctx.moveTo(173, 83);
    ctx.lineTo(83, 173);
    ctx.stroke();

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;

    closeButton = new THREE.Mesh(
        new THREE.PlaneGeometry(0.065, 0.065),
        createMenuMaterial(texture)
    );

    closeButton.position.set(
        MENU_WIDTH / 2 - 0.055,
        MENU_HEIGHT / 2 - 0.055,
        0.04
    );

    menuGroup.add(closeButton);
}

// ======================================================
// CRÉATION DU MENU
// ======================================================

function createMenu() {
    if (menuGroup) return;

    menuGroup = new THREE.Group();

    // Aucun grand rectangle noir derrière le menu.
    const title = new THREE.Mesh(
        new THREE.PlaneGeometry(0.53, 0.09),
        createMenuMaterial(
            createTextTexture(
                "QUEST SCANNER",
                "Controle gestuel"
            )
        )
    );

    title.position.set(0, 0.27, 0.035);
    menuGroup.add(title);

    createCloseButton();

    createMenuButton(
        "SENSIBILITE",
        "Regler la portee du scan",
        "sensitivity",
        0.145
    );

    createMenuButton(
        "ACTUALISER LE SCAN",
        "Demander une capture Meta",
        "rescan",
        -0.015
    );

    createMenuButton(
        "MAINS / BRAS",
        "Afficher ou masquer l'estimation",
        "arms",
        -0.13
    );

    createMenuButton(
        "SCAN DES DISTANCES",
        "Afficher ou masquer le scan",
        "distance",
        -0.245
    );

    // Slider de sensibilité.
    const sliderBackground = new THREE.Mesh(
        new THREE.PlaneGeometry(0.47, 0.018),
        new THREE.MeshBasicMaterial({
            color: 0x30465d,
            side: THREE.DoubleSide,
            depthTest: false,
            depthWrite: false
        })
    );

    sliderBackground.position.set(0, 0.075, 0.04);
    menuGroup.add(sliderBackground);

    const sliderFill = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 0.018),
        new THREE.MeshBasicMaterial({
            color: 0x5cf0c0,
            side: THREE.DoubleSide,
            depthTest: false,
            depthWrite: false
        })
    );

    sliderFill.position.set(-0.235, 0.075, 0.045);
    sliderFill.scale.x = 0.01;

    menuGroup.add(sliderFill);

    menuGroup.userData.sliderFill = sliderFill;

    scene.add(menuGroup);

    menuGroup.visible = false;

    updateMenu();
}

// ======================================================
// APPARENCE DES BOUTONS
// ======================================================

function updateButtonAppearance(button, selected) {
    if (button.userData.selected === selected) return;

    button.userData.selected = selected;

    if (button.material.map) {
        button.material.map.dispose();
    }

    const action = button.userData.action;

    const titles = {
        arms: armScanEnabled
            ? "MAINS / BRAS : ON"
            : "MAINS / BRAS : OFF",

        distance: distanceScanEnabled
            ? "DISTANCES : ON"
            : "DISTANCES : OFF",

        sensitivity:
            `SENSIBILITE : ${maxDistance.toFixed(1)} m`
    };

    button.material.map = createTextTexture(
        titles[action] || button.userData.defaultTitle,
        selected
            ? "Pince pour selectionner"
            : button.userData.subtitle,
        selected
    );

    button.material.needsUpdate = true;
}

function updateMenu() {
    if (!menuGroup) return;

    const slider = menuGroup.userData.sliderFill;

    if (slider) {
        const ratio =
            (maxDistance - MIN_DISTANCE) /
            (MAX_DISTANCE - MIN_DISTANCE);

        slider.scale.x = Math.max(0.01, ratio);

        slider.position.x =
            -0.235 + ratio * 0.235;
    }

    for (const button of menuButtons) {
        updateButtonAppearance(button, false);
    }
}

// ======================================================
// MENU FIXE DANS L'ESPACE
// ======================================================

function placeMenuAtWrist(frame, viewerPose) {
    if (!menuGroup) return false;

    const leftHand = getHand(frame, "left");

    if (!leftHand) return false;

    const wrist = getJointPosition(
        frame,
        leftHand.hand,
        "wrist"
    );

    if (!wrist) return false;

    const orientation = viewerPose.transform.orientation;

    const headQuaternion = new THREE.Quaternion(
        orientation.x,
        orientation.y,
        orientation.z,
        orientation.w
    );

    const up = new THREE.Vector3(0, 1, 0);
    const forward = new THREE.Vector3(0, 0, -1);

    up.applyQuaternion(headQuaternion);
    forward.applyQuaternion(headQuaternion);

    const position = wrist.clone()
        .addScaledVector(up, 0.30)
        .addScaledVector(forward, 0.08);

    // Position enregistrée une seule fois.
    // Elle n'est jamais recalculée à partir du poignet.
    menuGroup.position.copy(position);
    menuGroup.quaternion.copy(headQuaternion);

    menuGroup.updateMatrixWorld(true);

    return true;
}

// ======================================================
// RAYON INVISIBLE DE L'INDEX
// ======================================================

function getRightIndexRay(frame) {
    const rightHand = getHand(frame, "right");

    if (!rightHand) return null;

    const tip = getJointPosition(
        frame,
        rightHand.hand,
        "index-finger-tip"
    );

    const proximal = getJointPosition(
        frame,
        rightHand.hand,
        "index-finger-phalanx-proximal"
    );

    if (!tip || !proximal) return null;

    const direction = tip.clone().sub(proximal);

    if (direction.lengthSq() < 0.00001) {
        return null;
    }

    direction.normalize();

    return {
        source: rightHand,
        origin: tip,
        direction
    };
}

function getIndexMenuIntersection(frame) {
    if (!menuGroup?.visible) return null;

    menuGroup.updateMatrixWorld(true);

    const rayData = getRightIndexRay(frame);

    if (!rayData) return null;

    const normal = new THREE.Vector3(0, 0, 1)
        .applyQuaternion(menuGroup.quaternion);

    const plane = new THREE.Plane()
        .setFromNormalAndCoplanarPoint(
            normal,
            menuGroup.position
        );

    const ray = new THREE.Ray(
        rayData.origin,
        rayData.direction
    );

    const intersection = new THREE.Vector3();

    const hit = ray.intersectPlane(
        plane,
        intersection
    );

    if (!hit) return null;

    const distance = rayData.origin.distanceTo(intersection);

    if (distance > 2.0) return null;

    const local = menuGroup.worldToLocal(
        intersection.clone()
    );

    if (
        Math.abs(local.x) > MENU_WIDTH / 2 ||
        Math.abs(local.y) > MENU_HEIGHT / 2
    ) {
        return null;
    }

    return local;
}

// ======================================================
// PINCEMENT
// ======================================================

function getPinchDistance(frame, source) {
    if (!source?.hand) return null;

    const thumb = getJointPosition(
        frame,
        source.hand,
        "thumb-tip"
    );

    const index = getJointPosition(
        frame,
        source.hand,
        "index-finger-tip"
    );

    if (!thumb || !index) return null;

    return thumb.distanceTo(index);
}

function isPinching(frame, source) {
    const distance = getPinchDistance(frame, source);

    if (distance === null) return false;

    if (
        !pinchActive &&
        distance < PINCH_START_DISTANCE
    ) {
        pinchActive = true;
    } else if (
        pinchActive &&
        distance > PINCH_RELEASE_DISTANCE
    ) {
        pinchActive = false;
    }

    return pinchActive;
}

function getButtonAtPoint(local) {
    if (!local) return null;

    for (const button of menuButtons) {
        const p = button.position;

        if (
            Math.abs(local.x - p.x) <= 0.265 &&
            Math.abs(local.y - p.y) <= 0.043
        ) {
            return button;
        }
    }

    return null;
}

function isCloseButtonAtPoint(local) {
    if (!local || !closeButton) return false;

    return (
        Math.abs(local.x - closeButton.position.x) <= 0.045 &&
        Math.abs(local.y - closeButton.position.y) <= 0.045
    );
}

function isSliderAtPoint(local) {
    return !!local &&
        local.y >= 0.065 &&
        local.y <= 0.085 &&
        Math.abs(local.x) <= 0.245;
}

function changeSensitivityFromPoint(local) {
    const ratio = THREE.MathUtils.clamp(
        (local.x + 0.235) / 0.47,
        0,
        1
    );

    setSensitivity(
        MIN_DISTANCE +
        ratio * (MAX_DISTANCE - MIN_DISTANCE)
    );
}

// ======================================================
// INTERACTION DU MENU
// ======================================================

function updateMenuInteraction(frame, time) {
    if (!menuOpen || !menuGroup?.visible) return;

    const rightHand = getHand(frame, "right");

    if (!rightHand) {
        pinchWasActive = false;
        pinchActive = false;
        activeTouch = null;

        for (const button of menuButtons) {
            updateButtonAppearance(button, false);
        }

        return;
    }

    const pinching = isPinching(frame, rightHand);
    const local = getIndexMenuIntersection(frame);

    const hoveredButton = getButtonAtPoint(local);

    for (const button of menuButtons) {
        updateButtonAppearance(
            button,
            button === hoveredButton
        );
    }

    const justPinched =
        pinching && !pinchWasActive;

    if (time < menuInteractionUnlockTime) {
        pinchWasActive = pinching;
        return;
    }

    if (justPinched && local) {
        if (isCloseButtonAtPoint(local)) {
            closeMenu();
            return;
        }

        if (isSliderAtPoint(local)) {
            activeTouch = "sensitivity";
            changeSensitivityFromPoint(local);
        } else if (hoveredButton) {
            activeTouch = hoveredButton.userData.action;
            activateMenuAction(activeTouch);
        }
    }

    if (
        pinching &&
        activeTouch === "sensitivity" &&
        local &&
        isSliderAtPoint(local)
    ) {
        changeSensitivityFromPoint(local);
    }

    if (!pinching) {
        activeTouch = null;
    }

    pinchWasActive = pinching;
}

// ======================================================
// ACTIONS DU MENU
// ======================================================

function activateMenuAction(action) {
    switch (action) {
        case "rescan":
            initiateRoomCapture();
            break;

        case "arms":
            armScanEnabled = !armScanEnabled;

            updateMenu();

            messageElement.textContent =
                armScanEnabled
                    ? "Estimation des mains active."
                    : "Estimation des mains masquee.";

            break;

        case "distance":
            distanceScanEnabled = !distanceScanEnabled;

            updateMenu();
            updateScanVisibility();

            messageElement.textContent =
                distanceScanEnabled
                    ? "Scan des distances active."
                    : "Scan des distances masque.";

            break;
    }
}

// ======================================================
// OUVERTURE ET FERMETURE
// ======================================================

function openMenu(frame, viewerPose, time) {
    if (menuOpen) return;

    if (!menuGroup) {
        createMenu();
    }

    if (!placeMenuAtWrist(frame, viewerPose)) {
        return;
    }

    menuOpen = true;
    menuGroup.visible = true;

    menuInteractionUnlockTime =
        time + MENU_INTERACTION_DELAY;

    pinchWasActive = false;
    pinchActive = false;
    activeTouch = null;

    messageElement.textContent =
        "Menu place. Tu peux maintenant utiliser ton index et pincer.";
}

function closeMenu() {
    menuOpen = false;

    if (menuGroup) {
        menuGroup.visible = false;
    }

    pinchWasActive = false;
    pinchActive = false;
    activeTouch = null;

    messageElement.textContent =
        "Menu ferme. Fais le geste Rock pour le replacer.";
}

function updateMenuState(frame, viewerPose, time) {
    if (!menuOpen && detectLeftRock(frame)) {
        openMenu(frame, viewerPose, time);
    }

    // Le menu n'est jamais repositionné après son apparition.
    if (menuOpen) {
        updateMenuInteraction(frame, time);
    }
}

// ======================================================
// SEGMENTS ARRONDIS
// ======================================================

function createSegment(radius = 0.014) {
    const group = new THREE.Group();

    const material = createDepthMaterial();

    const cylinder = new THREE.Mesh(
        new THREE.CylinderGeometry(
            radius,
            radius,
            1,
            16
        ),
        material
    );

    const top = new THREE.Mesh(
        new THREE.SphereGeometry(radius, 16, 12),
        material
    );

    const bottom = new THREE.Mesh(
        new THREE.SphereGeometry(radius, 16, 12),
        material
    );

    group.add(cylinder);
    group.add(top);
    group.add(bottom);

    group.userData.cylinder = cylinder;
    group.userData.top = top;
    group.userData.bottom = bottom;

    group.userData.currentStart = null;
    group.userData.currentEnd = null;

    scene.add(group);

    return group;
}

function updateSegment(mesh, start, end) {
    if (!mesh.userData.currentStart) {
        mesh.userData.currentStart = start.clone();
        mesh.userData.currentEnd = end.clone();
    } else {
        mesh.userData.currentStart.lerp(
            start,
            SMOOTHING
        );

        mesh.userData.currentEnd.lerp(
            end,
            SMOOTHING
        );
    }

    const smoothStart = mesh.userData.currentStart;
    const smoothEnd = mesh.userData.currentEnd;

    const direction = new THREE.Vector3()
        .subVectors(smoothEnd, smoothStart);

    const length = direction.length();

    if (length < 0.001) {
        mesh.visible = false;
        return;
    }

    mesh.visible = true;

    mesh.position.copy(smoothStart)
        .add(smoothEnd)
        .multiplyScalar(0.5);

    mesh.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        direction.normalize()
    );

    mesh.userData.cylinder.scale.y = length;

    mesh.userData.top.position.set(
        0,
        length / 2,
        0
    );

    mesh.userData.bottom.position.set(
        0,
        -length / 2,
        0
    );
}

function createJointSphere(radius = 0.014) {
    const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(radius, 16, 12),
        createDepthMaterial()
    );

    mesh.userData.initialized = false;

    scene.add(mesh);

    return mesh;
}

function updateJoint(mesh, position) {
    if (!mesh.userData.initialized) {
        mesh.position.copy(position);
        mesh.userData.initialized = true;
    } else {
        mesh.position.lerp(
            position,
            SMOOTHING
        );
    }

    mesh.visible = true;
}

// ======================================================
// CINÉMATIQUE INVERSE DU BRAS
// ======================================================

// Calcule le coude à partir de :
// - l'épaule
// - le poignet
// - la longueur du bras
// - la longueur de l'avant-bras
//
// Le coude est placé à l'intersection de deux sphères.

function calculateElbow(
    shoulder,
    wrist,
    upperLength,
    forearmLength,
    preferredBend
) {
    const direction = wrist.clone().sub(shoulder);

    const originalDistance = direction.length();

    if (originalDistance < 0.001) {
        return shoulder.clone();
    }

    const axis = direction.normalize();

    // On garde une configuration géométriquement possible.
    const minimumReach = Math.abs(
        upperLength - forearmLength
    ) + 0.005;

    const maximumReach =
        upperLength + forearmLength - 0.005;

    const distance = THREE.MathUtils.clamp(
        originalDistance,
        minimumReach,
        maximumReach
    );

    // Distance entre l'épaule et la projection du coude
    // sur l'axe épaule-poignet.
    const along = (
        upperLength * upperLength -
        forearmLength * forearmLength +
        distance * distance
    ) / (2 * distance);

    // Hauteur du coude par rapport à l'axe.
    const height = Math.sqrt(
        Math.max(
            0,
            upperLength * upperLength - along * along
        )
    );

    // Direction préférée de flexion du coude.
    // On la projette perpendiculairement à l'axe du bras.
    const bend = preferredBend.clone();

    bend.addScaledVector(
        axis,
        -bend.dot(axis)
    );

    if (bend.lengthSq() < 0.0001) {
        bend.set(0, 0, 1);

        bend.addScaledVector(
            axis,
            -bend.dot(axis)
        );
    }

    bend.normalize();

    return shoulder.clone()
        .addScaledVector(axis, along)
        .addScaledVector(bend, height);
}

// ======================================================
// MAINS ET BRAS
// ======================================================

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
        upperArm: createSegment(0.035),
        lowerArm: createSegment(0.027),

        elbow: createJointSphere(0.022),
        wrist: createJointSphere(0.014),

        palm: new THREE.Mesh(
            new THREE.SphereGeometry(1, 20, 16),
            createDepthMaterial()
        ),

        fingerSegments: [],
        fingerJoints: []
    };
}

function ensureFingerVisuals(visual) {
    if (visual.fingerSegments.length > 0) return;

    for (let f = 0; f < fingerChains.length; f++) {
        const chain = fingerChains[f];

        const segments = [];
        const joints = [];

        for (let j = 1; j < chain.length; j++) {
            const radius = f === 0 ? 0.013 : 0.012;

            segments.push(createSegment(radius));
            joints.push(createJointSphere(radius));
        }

        visual.fingerSegments.push(segments);
        visual.fingerJoints.push(joints);
    }

    scene.add(visual.palm);

    visual.palm.scale.set(
        0.050,
        0.060,
        0.022
    );

    visual.palm.userData.initialized = false;
}

// ======================================================
// MISE À JOUR D'UN BRAS
// ======================================================

function updateHandArm(
    source,
    frame,
    viewerPosition,
    viewerQuaternion
) {
    if (!source.hand) return;

    const key = source.handedness;

    let visual = armVisuals.get(key);

    if (!visual) {
        visual = createHandVisual();
        armVisuals.set(key, visual);
    }

    ensureFingerVisuals(visual);

    const hand = source.hand;

    const wrist = getJointPosition(
        frame,
        hand,
        "wrist"
    );

    if (!wrist) {
        hideHandVisual(visual);
        return;
    }

    // Position de l'épaule :
    // légèrement en dessous et sur le côté du casque.
    const shoulderOffset = new THREE.Vector3(
        key === "left"
            ? -SHOULDER_SIDE_OFFSET
            : SHOULDER_SIDE_OFFSET,

        -SHOULDER_DOWN_OFFSET,

        0.025
    );

    shoulderOffset.applyQuaternion(viewerQuaternion);

    const shoulder = viewerPosition.clone()
        .add(shoulderOffset);

    // Direction préférée du coude :
    // légèrement vers l'extérieur et vers l'avant.
    const outward = new THREE.Vector3(
        key === "left" ? -1 : 1,
        0,
        0
    ).applyQuaternion(viewerQuaternion);

    const forward = new THREE.Vector3(0, 0, -1)
        .applyQuaternion(viewerQuaternion);

    const preferredBend = outward
        .multiplyScalar(0.65)
        .addScaledVector(forward, 0.75);

    // Longueurs anatomiques estimées.
    let upperLength = UPPER_ARM_LENGTH;
    let forearmLength = FOREARM_LENGTH;

    // Si la distance épaule-poignet dépasse la portée,
    // on adapte les deux longueurs proportionnellement.
    // Le rapport entre bras et avant-bras reste constant.
    const shoulderWristDistance =
        shoulder.distanceTo(wrist);

    const maximumLength =
        upperLength + forearmLength - 0.005;

    if (shoulderWristDistance > maximumLength) {
        const ratio =
            shoulderWristDistance / maximumLength;

        upperLength *= ratio;
        forearmLength *= ratio;
    }

    const elbow = calculateElbow(
        shoulder,
        wrist,
        upperLength,
        forearmLength,
        preferredBend
    );

    updateSegment(
        visual.upperArm,
        shoulder,
        elbow
    );

    updateSegment(
        visual.lowerArm,
        elbow,
        wrist
    );

    updateJoint(visual.elbow, elbow);
    updateJoint(visual.wrist, wrist);

    const palmCenter = getJointPosition(
        frame,
        hand,
        "middle-finger-metacarpal"
    );

    if (palmCenter) {
        const targetPalm = wrist.clone()
            .lerp(palmCenter, 0.72);

        if (!visual.palm.userData.initialized) {
            visual.palm.position.copy(targetPalm);
            visual.palm.userData.initialized = true;
        } else {
            visual.palm.position.lerp(
                targetPalm,
                SMOOTHING
            );
        }

        visual.palm.visible = armScanEnabled;
    }

    const show = armScanEnabled;

    visual.upperArm.visible = show;
    visual.lowerArm.visible = show;
    visual.elbow.visible = show;
    visual.wrist.visible = show;

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

            const segment =
                visual.fingerSegments[f][j - 1];

            const joint =
                visual.fingerJoints[f][j - 1];

            if (a && b) {
                updateSegment(segment, a, b);
                updateJoint(joint, b);

                segment.visible = show;
                joint.visible = show;
            } else {
                segment.visible = false;
                joint.visible = false;
            }
        }
    }
}

function hideHandVisual(visual) {
    visual.upperArm.visible = false;
    visual.lowerArm.visible = false;

    visual.elbow.visible = false;
    visual.wrist.visible = false;
    visual.palm.visible = false;

    visual.fingerSegments.flat().forEach(mesh => {
        mesh.visible = false;
    });

    visual.fingerJoints.flat().forEach(mesh => {
        mesh.visible = false;
    });
}

function updateArms(frame, viewerPosition, viewerQuaternion) {
    if (!enabledFeatures.includes("hand-tracking")) return;

    const seen = new Set();

    for (const source of session.inputSources) {
        if (!source.hand) continue;

        seen.add(source.handedness);

        updateHandArm(
            source,
            frame,
            viewerPosition,
            viewerQuaternion
        );
    }

    for (const [key, visual] of armVisuals) {
        if (!seen.has(key)) {
            hideHandVisual(visual);
        }
    }
}

// ======================================================
// GÉOMÉTRIE DES PLANS
// ======================================================

function createPlaneGeometry(polygon) {
    const positions = [];

    for (const point of polygon) {
        positions.push(
            point.x,
            point.y,
            point.z
        );
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

// ======================================================
// MAILLAGES 3D
// ======================================================

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

    const geometryChanged =
        changedTime !== visual.lastChangedTime ||
        vertices.length !== visual.vertexCount ||
        indices.length !== visual.indexCount;

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
    visual.vertexCount = vertices.length;
    visual.indexCount = indices.length;

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

// ======================================================
// VISIBILITÉ DU SCAN
// ======================================================

function updateScanVisibility() {
    for (const visual of planeVisuals.values()) {
        visual.group.visible = distanceScanEnabled;
    }

    for (const visual of meshVisuals.values()) {
        visual.group.visible = distanceScanEnabled;
    }
}

// ======================================================
// ROOM CAPTURE
// ======================================================

async function initiateRoomCapture() {
    if (!session || !isRunning) return;

    if (roomCaptureAttempted) {
        messageElement.textContent =
            "Une capture a déjà été demandée dans cette session.";

        return;
    }

    if (typeof session.initiateRoomCapture !== "function") {
        roomCaptureStatus = "API indisponible.";

        messageElement.textContent =
            "La capture de pièce n'est pas disponible.";

        return;
    }

    roomCaptureAttempted = true;
    roomCaptureStatus = "Demande envoyée.";

    messageElement.textContent =
        "Demande de capture envoyée à Meta.";

    try {
        const result = session.initiateRoomCapture();

        if (result?.then) {
            await result;
        }

        messageElement.textContent =
            "Termine la capture dans l'interface Meta si elle apparaît.";

    } catch (error) {
        roomCaptureStatus = "Erreur : " + error.message;

        messageElement.textContent = roomCaptureStatus;

        console.error(error);
    }
}

// ======================================================
// BOUCLE DE RENDU
// ======================================================

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

    const orientation = viewerPose.transform.orientation;

    const viewerQuaternion = new THREE.Quaternion(
        orientation.x,
        orientation.y,
        orientation.z,
        orientation.w
    );

    updateMenuState(
        frame,
        viewerPose,
        time
    );

    updateArms(
        frame,
        viewerPosition,
        viewerQuaternion
    );

    const planes = frame.detectedPlanes
        ? Array.from(frame.detectedPlanes)
        : [];

    const meshes = frame.detectedMeshes
        ? Array.from(frame.detectedMeshes)
        : [];

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

// ======================================================
// NETTOYAGE
// ======================================================

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
    closeButton = null;

    scene.clear();
    scene = null;
}

// ======================================================
// ARRÊT
// ======================================================

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

    menuOpen = false;
    pinchWasActive = false;
    pinchActive = false;
    activeTouch = null;

    document.body.classList.remove("xr-active");

    startButton.disabled = false;

    statusElement.textContent = "Scan terminé";
    messageElement.textContent = report;

    planeCountElement.textContent = "0";
    nearestDistanceElement.textContent = "—";
}

// ======================================================
// DÉMARRAGE
// ======================================================

async function enterAR() {
    startButton.disabled = true;

    messageElement.textContent =
        "Initialisation du scanner...";

    roomCaptureAttempted = false;
    roomCaptureStatus = "En attente";

    maxDistance = DEFAULT_DISTANCE;

    menuOpen = false;
    pinchWasActive = false;
    pinchActive = false;
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

        // Transparence WebXR originale.
        renderer.setClearColor(0x000000, 0);
        renderer.setClearAlpha(0);

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

        messageElement.textContent =
            enabledFeatures.includes("hand-tracking")
                ? "Fais le geste Rock avec la main gauche pour placer le menu."
                : "Hand Tracking indisponible.";

        console.info(
            "Fonctionnalités WebXR :",
            enabledFeatures
        );

        session.addEventListener(
            "end",
            stopAR,
            { once: true }
        );

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

// ======================================================
// REDIMENSIONNEMENT
// ======================================================

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

// ======================================================
// INITIALISATION
// ======================================================

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
            throw new Error(
                "Mode immersive-ar indisponible."
            );
        }

        statusElement.textContent = "WebXR détecté";
        messageElement.textContent = "Scanner prêt.";

        startButton.disabled = false;

    } catch (error) {
        statusElement.textContent = "Non compatible";
        messageElement.textContent = error.message;
    }
}
