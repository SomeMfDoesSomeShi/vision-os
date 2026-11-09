
import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";

// ======================================================
// CONFIGURATION
// ======================================================

const MENU_INTERACTION_DELAY = 5000;

const PINCH_START_DISTANCE = 0.032;
const PINCH_RELEASE_DISTANCE = 0.055;

const SMOOTHING = 0.32;

const MENU_WIDTH = 0.62;
const MENU_HEIGHT = 0.42;

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

let armScanEnabled = true;

let menuOpen = false;
let menuInteractionUnlockTime = 0;

let leftRockWasActive = false;

let pinchWasActive = false;
let pinchActive = false;
let activeTouch = null;

let menuGroup = null;
let menuButtons = [];
let closeButton = null;

let pointerLine = null;
let pointerDot = null;

let pointerHit = null;
let pointerLocalHit = null;

let roomCaptureAttempted = false;
let roomCaptureStatus = "En attente";

const planeVisuals = new Map();
const meshVisuals = new Map();
const armVisuals = new Map();

// ======================================================
// MATÉRIAUX
// ======================================================

// Plus aucun shader de profondeur.
// Les surfaces du scan sont simplement affichées en filaire.

function createScanMaterial() {
    return new THREE.MeshBasicMaterial({
        color: 0x5cf0c0,
        transparent: true,
        opacity: 0.65,
        side: THREE.DoubleSide,
        wireframe: true,
        depthWrite: false,
        depthTest: true,
        toneMapped: false
    });
}

function createHandMaterial() {
    return new THREE.MeshBasicMaterial({
        color: 0x75cfff,
        transparent: true,
        opacity: 0.9,
        side: THREE.DoubleSide,
        depthWrite: false,
        toneMapped: false
    });
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

    return new THREE.Vector3(p.x, p.y, p.z);
}

function getHand(frame, handedness) {
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
// TEXTURES DU MENU
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
    ctx.strokeRect(4, 4, canvas.width - 8, canvas.height - 8);

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

// ======================================================
// CRÉATION DES BOUTONS
// ======================================================

function createMenuButton(label, subtitle, action, x, y, width = 0.53, height = 0.085) {
    const material = new THREE.MeshBasicMaterial({
        map: createTextTexture(label, subtitle),
        side: THREE.DoubleSide,
        depthTest: false,
        depthWrite: false
    });

    const button = new THREE.Mesh(
        new THREE.PlaneGeometry(width, height),
        material
    );

    button.position.set(x, y, 0.015);

    button.renderOrder = 10;

    button.userData.action = action;
    button.userData.defaultTitle = label;
    button.userData.subtitle = subtitle;
    button.userData.selected = false;
    button.userData.width = width;
    button.userData.height = height;

    menuGroup.add(button);
    menuButtons.push(button);

    return button;
}

// ======================================================
// CRÉATION DE LA FENÊTRE
// ======================================================

function createMenu() {
    if (menuGroup) return;

    menuGroup = new THREE.Group();

    // Aucun grand panneau noir derrière les boutons.
    // Chaque élément possède son propre fond.

    const title = new THREE.Mesh(
        new THREE.PlaneGeometry(0.53, 0.09),
        new THREE.MeshBasicMaterial({
            map: createTextTexture(
                "QUEST SCANNER",
                "Menu spatial"
            ),
            side: THREE.DoubleSide,
            depthTest: false,
            depthWrite: false
        })
    );

    title.position.set(-0.025, 0.15, 0.015);
    title.renderOrder = 10;

    menuGroup.add(title);

    // Bouton de fermeture en haut à droite.

    closeButton = createMenuButton(
        "X",
        "FERMER",
        "close",
        0.255,
        0.15,
        0.075,
        0.075
    );

    createMenuButton(
        "ACTUALISER LE SCAN",
        "Demander une nouvelle capture Meta",
        "rescan",
        0,
        0.015
    );

    createMenuButton(
        "MAINS / BRAS",
        "Afficher ou masquer leur estimation",
        "arms",
        0,
        -0.105
    );

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

    let title = button.userData.defaultTitle;

    if (button.userData.action === "arms") {
        title = armScanEnabled
            ? "MAINS / BRAS : ON"
            : "MAINS / BRAS : OFF";
    }

    button.material.map = createTextTexture(
        title,
        selected
            ? "Pince pour selectionner"
            : button.userData.subtitle,
        selected
    );

    button.material.needsUpdate = true;
}

function updateMenu() {
    for (const button of menuButtons) {
        updateButtonAppearance(button, false);
    }
}

// ======================================================
// POSITION INITIALE DE LA FENÊTRE
// ======================================================

// La fenêtre est placée une seule fois.
// Elle ne suit plus le poignet ou la tête.

function placeMenuAtOpening(viewerPose) {
    if (!menuGroup) return;

    const orientation = viewerPose.transform.orientation;

    const headQuaternion = new THREE.Quaternion(
        orientation.x,
        orientation.y,
        orientation.z,
        orientation.w
    );

    const viewerPosition = new THREE.Vector3(
        viewerPose.transform.position.x,
        viewerPose.transform.position.y,
        viewerPose.transform.position.z
    );

    const forward = new THREE.Vector3(0, 0, -1);
    const up = new THREE.Vector3(0, 1, 0);

    forward.applyQuaternion(headQuaternion);
    up.applyQuaternion(headQuaternion);

    const targetPosition = viewerPosition.clone()
        .addScaledVector(forward, 0.85)
        .addScaledVector(up, -0.08);

    // Position et orientation fixes dans l'espace.
    menuGroup.position.copy(targetPosition);
    menuGroup.quaternion.copy(headQuaternion);

    menuGroup.visible = true;

    menuGroup.updateMatrixWorld(true);
}

// ======================================================
// OUVERTURE ET FERMETURE
// ======================================================

function openMenu(frame, viewerPose, time) {
    if (menuOpen) return;

    if (!menuGroup) {
        createMenu();
    }

    menuOpen = true;

    placeMenuAtOpening(viewerPose);

    menuInteractionUnlockTime =
        time + MENU_INTERACTION_DELAY;

    pinchWasActive = false;
    pinchActive = false;
    activeTouch = null;

    messageElement.textContent =
        "Fenêtre ouverte. Attends 5 secondes avant de pincer.";
}

function closeMenuImmediately() {
    menuOpen = false;

    if (menuGroup) {
        menuGroup.visible = false;
    }

    pinchWasActive = false;
    pinchActive = false;
    activeTouch = null;

    hidePointer();

    messageElement.textContent =
        "Fenêtre fermée. Fais le geste Rock pour la rouvrir.";
}

// ======================================================
// POINTEUR LASER
// ======================================================

function createPointer() {
    const geometry = new THREE.BufferGeometry();

    geometry.setFromPoints([
        new THREE.Vector3(),
        new THREE.Vector3(0, 0, -1)
    ]);

    pointerLine = new THREE.Line(
        geometry,
        new THREE.LineBasicMaterial({
            color: 0x5cf0c0,
            transparent: true,
            opacity: 0.95,
            depthTest: false
        })
    );

    pointerLine.frustumCulled = false;
    pointerLine.renderOrder = 20;

    pointerDot = new THREE.Mesh(
        new THREE.SphereGeometry(0.009, 12, 12),
        new THREE.MeshBasicMaterial({
            color: 0x5cf0c0,
            depthTest: false
        })
    );

    pointerLine.visible = false;
    pointerDot.visible = false;

    pointerDot.renderOrder = 21;

    scene.add(pointerLine);
    scene.add(pointerDot);
}

function hidePointer() {
    if (pointerLine) pointerLine.visible = false;
    if (pointerDot) pointerDot.visible = false;

    pointerHit = null;
    pointerLocalHit = null;
}

function getRightIndexRay(frame) {
    const rightHand = getHand(frame, "right");

    if (!rightHand) return null;

    const hand = rightHand.hand;

    const tip = getJointPosition(
        frame,
        hand,
        "index-finger-tip"
    );

    const proximal = getJointPosition(
        frame,
        hand,
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

function updatePointer(frame) {
    if (!menuOpen || !menuGroup?.visible) {
        hidePointer();
        return;
    }

    const rayData = getRightIndexRay(frame);

    if (!rayData) {
        hidePointer();
        return;
    }

    const { origin, direction } = rayData;

    const normal = new THREE.Vector3(0, 0, 1)
        .applyQuaternion(menuGroup.quaternion);

    const plane = new THREE.Plane()
        .setFromNormalAndCoplanarPoint(
            normal,
            menuGroup.position
        );

    const ray = new THREE.Ray(origin, direction);

    const intersection = new THREE.Vector3();

    const hit = ray.intersectPlane(
        plane,
        intersection
    );

    let end;

    if (hit) {
        const inverse = menuGroup.matrixWorld.clone().invert();

        const local = intersection.clone().applyMatrix4(inverse);

        const inside =
            Math.abs(local.x) <= MENU_WIDTH / 2 &&
            Math.abs(local.y) <= MENU_HEIGHT / 2;

        if (inside) {
            pointerHit = intersection.clone();
            pointerLocalHit = local.clone();
            end = intersection.clone();
        } else {
            pointerHit = null;
            pointerLocalHit = null;

            end = origin.clone().addScaledVector(
                direction,
                0.7
            );
        }
    } else {
        pointerHit = null;
        pointerLocalHit = null;

        end = origin.clone().addScaledVector(
            direction,
            0.7
        );
    }

    pointerLine.geometry.setFromPoints([
        origin,
        end
    ]);

    pointerLine.visible = true;

    pointerDot.position.copy(end);
    pointerDot.visible = true;

    pointerDot.scale.setScalar(
        pointerHit ? 1.5 : 1
    );
}

// ======================================================
// PINCER POUR CLIQUER
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

// ======================================================
// DÉTECTION DES BOUTONS
// ======================================================

function getButtonAtPoint(local) {
    if (!local) return null;

    for (const button of menuButtons) {
        const p = button.position;

        const halfWidth = button.userData.width / 2;
        const halfHeight = button.userData.height / 2;

        if (
            Math.abs(local.x - p.x) <= halfWidth &&
            Math.abs(local.y - p.y) <= halfHeight
        ) {
            return button;
        }
    }

    return null;
}

// ======================================================
// INTERACTION DU MENU
// ======================================================

function updateMenuTouch(frame, time) {
    if (!menuOpen || !menuGroup?.visible) return;

    const rightHand = getHand(frame, "right");

    if (!rightHand) {
        pinchWasActive = false;
        pinchActive = false;
        activeTouch = null;
        return;
    }

    const pinching = isPinching(frame, rightHand);

    const local = pointerLocalHit;
    const hoveredButton = getButtonAtPoint(local);

    for (const button of menuButtons) {
        updateButtonAppearance(
            button,
            button === hoveredButton
        );
    }

    // Sécurité de 5 secondes après ouverture.
    if (time < menuInteractionUnlockTime) {
        pinchWasActive = pinching;
        activeTouch = null;
        return;
    }

    const justPinched = pinching && !pinchWasActive;

    if (justPinched && pointerHit && hoveredButton) {
        activeTouch = hoveredButton.userData.action;

        activateMenuAction(activeTouch);
    }

    if (!pinching) {
        activeTouch = null;
    }

    pinchWasActive = pinching;
}

// ======================================================
// ACTIONS MENU
// ======================================================

function activateMenuAction(action) {
    switch (action) {
        case "close":
            closeMenuImmediately();
            break;

        case "rescan":
            initiateRoomCapture();
            break;

        case "arms":
            armScanEnabled = !armScanEnabled;

            updateMenu();

            messageElement.textContent =
                armScanEnabled
                    ? "Estimation des mains et des bras active."
                    : "Estimation des mains et des bras masquee.";

            break;
    }
}

// ======================================================
// GESTE ROCK : OUVERTURE UNIQUE
// ======================================================

function updateMenuState(frame, viewerPose, time) {
    const rock = detectLeftRock(frame);

    // Uniquement au moment où le geste commence.
    if (rock && !leftRockWasActive && !menuOpen) {
        openMenu(
            frame,
            viewerPose,
            time
        );
    }

    leftRockWasActive = rock;

    // La position de la fenêtre n'est jamais recalculée ici.
    updatePointer(frame);
    updateMenuTouch(frame, time);
}

// ======================================================
// SEGMENTS ARRONDIS
// ======================================================

function createSegment(radius = 0.014) {
    const group = new THREE.Group();

    const material = createHandMaterial();

    const cylinder = new THREE.Mesh(
        new THREE.CylinderGeometry(
            radius,
            radius,
            1,
            12
        ),
        material
    );

    const top = new THREE.Mesh(
        new THREE.SphereGeometry(radius, 12, 10),
        material
    );

    const bottom = new THREE.Mesh(
        new THREE.SphereGeometry(radius, 12, 10),
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
        createHandMaterial()
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
// CHAÎNES DES DOIGTS
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

// ======================================================
// MAINS ET BRAS
// ======================================================

function createHandVisual() {
    return {
        // Deux segments au lieu d'un seul avant-bras.
        upperArm: createSegment(0.032),
        forearm: createSegment(0.028),

        // Pas de boule au poignet.
        elbow: createJointSphere(0.023),

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

        // Doigts plus épais.
        const radius = f === 0 ? 0.014 : 0.012;

        for (let j = 1; j < chain.length; j++) {
            segments.push(createSegment(radius));
            joints.push(createJointSphere(radius));
        }

        visual.fingerSegments.push(segments);
        visual.fingerJoints.push(joints);
    }
}

function updateHandArm(source, frame, viewerPosition, viewerQuaternion) {
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

    // Estimation de la position de l'épaule.
    // Elle est calculée dans l'orientation de la tête.
    const shoulderOffset = new THREE.Vector3(
        key === "left" ? -0.20 : 0.20,
        -0.22,
        0.025
    );

    shoulderOffset.applyQuaternion(viewerQuaternion);

    const shoulder = viewerPosition.clone()
        .add(shoulderOffset);

    // Coude intermédiaire.
    const elbow = shoulder.clone().lerp(wrist, 0.52);

    const show = armScanEnabled;

    updateSegment(
        visual.upperArm,
        shoulder,
        elbow
    );

    updateSegment(
        visual.forearm,
        elbow,
        wrist
    );

    updateJoint(
        visual.elbow,
        elbow
    );

    visual.upperArm.visible = show;
    visual.forearm.visible = show;
    visual.elbow.visible = show;

    // Doigts.
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
    visual.forearm.visible = false;
    visual.elbow.visible = false;

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
        createScanMaterial()
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

    return getWorldCenter(visual);
}

// ======================================================
// MAILLAGES 3D
// ======================================================

function createMeshVisual() {
    const group = new THREE.Group();

    const mesh = new THREE.Mesh(
        new THREE.BufferGeometry(),
        createScanMaterial()
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

    return getWorldCenter(visual);
}

// ======================================================
// CENTRE DU SCAN
// ======================================================

function getWorldCenter(visual) {
    const sphere = visual.mesh.geometry.boundingSphere;

    if (!sphere) return null;

    return sphere.center.clone().applyMatrix4(
        visual.group.matrix
    );
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

        if (center) {
            nearestDistance = Math.min(
                nearestDistance,
                viewerPosition.distanceTo(center)
            );
        }
    }

    for (const xrMesh of meshes) {
        const center = updateDetectedMesh(xrMesh, frame);

        if (center) {
            nearestDistance = Math.min(
                nearestDistance,
                viewerPosition.distanceTo(center)
            );
        }
    }

    planeCountElement.textContent =
        planeVisuals.size + meshVisuals.size;

    nearestDistanceElement.textContent =
        Number.isFinite(nearestDistance)
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

    pointerLine = null;
    pointerDot = null;

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
    leftRockWasActive = false;

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

    menuOpen = false;
    leftRockWasActive = false;

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
        }

        // La scène doit être recréée après chaque arrêt.
        if (!scene) {
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

        // Transparence du rendu WebGL, sans option caméra.
        renderer.setClearColor(0x000000, 0);
        renderer.setClearAlpha(0);

        await renderer.xr.setSession(session);

        referenceSpace = renderer.xr.getReferenceSpace();

        if (!referenceSpace) {
            throw new Error(
                "Impossible d'obtenir l'espace spatial."
            );
        }

        createPointer();

        document.body.classList.add("xr-active");

        isRunning = true;

        statusElement.textContent = "Scanner actif";

        messageElement.textContent =
            enabledFeatures.includes("hand-tracking")
                ? "Fais le geste Rock avec la main gauche pour ouvrir la fenêtre."
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

        camera = null;
        session = null;
        referenceSpace = null;

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
