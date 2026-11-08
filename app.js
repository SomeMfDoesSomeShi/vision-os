
import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";

// ==========================================
// CONFIGURATION
// ==========================================

const MIN_DISTANCE = 2;
const MAX_DISTANCE = 12;
const DEFAULT_DISTANCE = 6;

const OPEN_HAND_HOLD_TIME = 5000;
const PINCH_START_DISTANCE = 0.035;
const PINCH_RELEASE_DISTANCE = 0.055;
const SENSITIVITY_SPEED = 8;

// ==========================================
// ELEMENTS
// ==========================================

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

let roomCaptureAttempted = false;
let roomCaptureStatus = "Non déclenché";

let enabledFeatures = [];

let latestPlaneCount = 0;
let latestMeshCount = 0;

// Sensibilité des couleurs
let maxDistance = DEFAULT_DISTANCE;

// Contrôle gestuel
let openHandStart = null;
let adjustmentMode = false;
let controlHandedness = null;

let isPinching = false;
let previousPinchX = null;

// Geste ROCK conservé pour Room Capture
let rockStartTime = null;
let rockDetected = false;
let lastRockTime = 0;

const ROCK_HOLD_TIME = 700;
const ROCK_COOLDOWN = 5000;

const planeVisuals = new Map();
const meshVisuals = new Map();

// ==========================================
// SHADERS
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

// ==========================================
// SENSIBILITÉ
// ==========================================

function setSensitivity(value) {
    maxDistance = THREE.MathUtils.clamp(
        value,
        MIN_DISTANCE,
        MAX_DISTANCE
    );

    if (scene) {
        scene.traverse(object => {
            if (
                object.material &&
                object.material.uniforms &&
                object.material.uniforms.uMaxDistance
            ) {
                object.material.uniforms.uMaxDistance.value =
                    maxDistance;
            }
        });
    }

    const sensitivityPercent = Math.round(
        ((MAX_DISTANCE - maxDistance) /
        (MAX_DISTANCE - MIN_DISTANCE)) * 100
    );

    console.log("Sensibilité actualisée :", {
        distanceMaximale: maxDistance.toFixed(2),
        sensibilite: sensitivityPercent + "%"
    });

    messageElement.textContent =
        `Sensibilité : ${sensitivityPercent}% | Portée : ${maxDistance.toFixed(1)} m`;
}

// ==========================================
// HAND TRACKING
// ==========================================

function getJointPosition(frame, hand, jointName) {
    const joint = hand.get(jointName);

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

function jointDistance(frame, hand, jointA, jointB) {
    const a = getJointPosition(frame, hand, jointA);
    const b = getJointPosition(frame, hand, jointB);

    if (!a || !b) return null;

    return a.distanceTo(b);
}

// ==========================================
// DÉTECTION DES DOIGTS
// ==========================================

function isFingerExtended(
    frame,
    hand,
    wrist,
    proximalName,
    tipName
) {
    const proximal = getJointPosition(
        frame,
        hand,
        proximalName
    );

    const tip = getJointPosition(
        frame,
        hand,
        tipName
    );

    if (!proximal || !tip) return false;

    const baseDistance = wrist.distanceTo(proximal);
    const tipDistance = wrist.distanceTo(tip);

    return tipDistance > baseDistance * 1.18;
}

function isFingerCurled(
    frame,
    hand,
    wrist,
    proximalName,
    tipName
) {
    const proximal = getJointPosition(
        frame,
        hand,
        proximalName
    );

    const tip = getJointPosition(
        frame,
        hand,
        tipName
    );

    if (!proximal || !tip) return false;

    const baseDistance = wrist.distanceTo(proximal);
    const tipDistance = wrist.distanceTo(tip);

    return tipDistance < baseDistance * 1.18;
}

// ==========================================
// DÉTECTION MAIN OUVERTE
// ==========================================

function isOpenHand(frame, hand) {
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

    const middle = isFingerExtended(
        frame, hand, wrist,
        "middle-finger-phalanx-proximal",
        "middle-finger-tip"
    );

    const ring = isFingerExtended(
        frame, hand, wrist,
        "ring-finger-phalanx-proximal",
        "ring-finger-tip"
    );

    const pinky = isFingerExtended(
        frame, hand, wrist,
        "pinky-finger-phalanx-proximal",
        "pinky-finger-tip"
    );

    const thumb = isFingerExtended(
        frame, hand, wrist,
        "thumb-phalanx-proximal",
        "thumb-tip"
    );

    return (
        index &&
        middle &&
        ring &&
        pinky &&
        thumb
    );
}

// ==========================================
// DÉTECTION PINCEMENT
// ==========================================

function getPinchDistance(frame, hand) {
    return jointDistance(
        frame,
        hand,
        "thumb-tip",
        "index-finger-tip"
    );
}

function getPinchCenter(frame, hand) {
    const thumb = getJointPosition(
        frame,
        hand,
        "thumb-tip"
    );

    const index = getJointPosition(
        frame,
        hand,
        "index-finger-tip"
    );

    if (!thumb || !index) return null;

    return thumb.add(index).multiplyScalar(0.5);
}

// ==========================================
// POSITION HORIZONTALE RELATIVE AU CASQUE
// ==========================================

function getViewerLocalX(position, viewerPose) {
    const viewerMatrix = new THREE.Matrix4()
        .fromArray(viewerPose.transform.matrix);

    viewerMatrix.invert();

    const localPosition = position.clone()
        .applyMatrix4(viewerMatrix);

    return localPosition.x;
}

// ==========================================
// ACTIVATION DU MODE RÉGLAGE
// ==========================================

function activateAdjustmentMode(handedness) {
    adjustmentMode = true;

    controlHandedness = handedness;

    isPinching = false;
    previousPinchX = null;

    openHandStart = null;

    console.log("MODE RÉGLAGE ACTIVÉ");

    statusElement.textContent = "Réglage des couleurs";

    messageElement.textContent =
        "Mode réglage actif ! Pince avec l'autre main et déplace-la horizontalement.";
}

// ==========================================
// DÉSACTIVATION DU MODE
// ==========================================

function deactivateAdjustmentMode() {
    adjustmentMode = false;
    controlHandedness = null;

    isPinching = false;
    previousPinchX = null;

    openHandStart = null;

    statusElement.textContent = "Scanner actif";

    messageElement.textContent =
        "Mode réglage terminé.";
}

// ==========================================
// CONTRÔLE DE LA SENSIBILITÉ
// ==========================================

function updateSensitivityGesture(
    frame,
    viewerPose,
    time
) {
    if (!enabledFeatures.includes("hand-tracking")) {
        return;
    }

    const sources = Array.from(session.inputSources)
        .filter(source => source.hand);

    // ======================================
    // ÉTAPE 1 : OUVRIR UNE MAIN 5 SECONDES
    // ======================================

    if (!adjustmentMode) {
        let detectedHand = null;

        for (const source of sources) {
            if (isOpenHand(frame, source.hand)) {
                detectedHand = source;
                break;
            }
        }

        if (!detectedHand) {
            openHandStart = null;
            return;
        }

        if (openHandStart === null) {
            openHandStart = time;

            messageElement.textContent =
                "Garde ta main ouverte pendant 5 secondes...";
        }

        const elapsed = time - openHandStart;

        const remaining = Math.max(
            0,
            Math.ceil((OPEN_HAND_HOLD_TIME - elapsed) / 1000)
        );

        if (remaining > 0) {
            messageElement.textContent =
                `Activation du réglage dans ${remaining} s...`;

            return;
        }

        activateAdjustmentMode(
            detectedHand.handedness
        );

        return;
    }

    // ======================================
    // ÉTAPE 2 : UTILISER L'AUTRE MAIN
    // ======================================

    const otherHand = sources.find(
        source =>
            source.handedness !== controlHandedness
    );

    if (!otherHand) {
        isPinching = false;
        previousPinchX = null;

        messageElement.textContent =
            "Mode réglage actif. Utilise l'autre main pour pincer.";

        return;
    }

    const pinchDistance = getPinchDistance(
        frame,
        otherHand.hand
    );

    const pinchCenter = getPinchCenter(
        frame,
        otherHand.hand
    );

    if (
        pinchDistance === null ||
        !pinchCenter
    ) {
        isPinching = false;
        previousPinchX = null;
        return;
    }

    // ======================================
    // ÉTAPE 3 : DÉBUT DU PINCEMENT
    // ======================================

    if (!isPinching) {
        if (pinchDistance < PINCH_START_DISTANCE) {
            isPinching = true;

            previousPinchX = getViewerLocalX(
                pinchCenter,
                viewerPose
            );

            messageElement.textContent =
                "Pincement détecté ! Déplace ta main à gauche ou à droite.";
        }

        return;
    }

    // ======================================
    // ÉTAPE 4 : FIN DU PINCEMENT
    // ======================================

    if (pinchDistance > PINCH_RELEASE_DISTANCE) {
        isPinching = false;
        previousPinchX = null;

        messageElement.textContent =
            `Réglage : ${maxDistance.toFixed(1)} m. Pince à nouveau pour continuer.`;

        return;
    }

    // ======================================
    // ÉTAPE 5 : DÉPLACEMENT HORIZONTAL
    // ======================================

    const currentX = getViewerLocalX(
        pinchCenter,
        viewerPose
    );

    if (previousPinchX === null) {
        previousPinchX = currentX;
        return;
    }

    const deltaX = currentX - previousPinchX;

    previousPinchX = currentX;

    // Droite = plus sensible.
    // Gauche = moins sensible.

    const newDistance =
        maxDistance - deltaX * SENSITIVITY_SPEED;

    setSensitivity(newDistance);
}

// ==========================================
// GESTE ROCK POUR ROOM CAPTURE
// ==========================================

function detectRockGesture(frame) {
    if (!enabledFeatures.includes("hand-tracking")) {
        return false;
    }

    for (const source of session.inputSources) {
        if (!source.hand) continue;

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
            return true;
        }
    }

    return false;
}

function updateRockGesture(frame, time) {
    if (adjustmentMode) {
        rockStartTime = null;
        rockDetected = false;
        return;
    }

    const detected = detectRockGesture(frame);

    if (!detected) {
        rockStartTime = null;
        rockDetected = false;
        return;
    }

    if (rockStartTime === null) {
        rockStartTime = time;
    }

    if (
        time - rockStartTime >= ROCK_HOLD_TIME &&
        !rockDetected &&
        time - lastRockTime > ROCK_COOLDOWN
    ) {
        rockDetected = true;
        lastRockTime = time;

        initiateRoomCapture();
    }
}

// ==========================================
// GÉOMÉTRIE DES PLANS
// ==========================================

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

// ==========================================
// CRÉATION D'UN PLAN
// ==========================================

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

// ==========================================
// MISE À JOUR D'UN PLAN
// ==========================================

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

    visual.group.matrix.fromArray(
        pose.transform.matrix
    );

    visual.group.matrixWorldNeedsUpdate = true;
    visual.group.visible = true;

    return getWorldCenter(visual);
}

// ==========================================
// CRÉATION D'UN MAILLAGE 3D
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

// ==========================================
// GÉOMÉTRIE DU MAILLAGE
// ==========================================

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

    console.info("Géométrie actualisée :", {
        label: xrMesh.semanticLabel,
        vertices: vertexCount / 3,
        indices: indexCount,
        lastChangedTime: changedTime
    });

    return true;
}

// ==========================================
// MISE À JOUR D'UN MAILLAGE
// ==========================================

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

    visual.group.matrix.fromArray(
        pose.transform.matrix
    );

    visual.group.matrixWorldNeedsUpdate = true;
    visual.group.visible = true;

    return getWorldCenter(visual);
}

// ==========================================
// CENTRE D'UN ÉLÉMENT
// ==========================================

function getWorldCenter(visual) {
    const sphere = visual.mesh.geometry.boundingSphere;

    if (!sphere) return null;

    return sphere.center.clone().applyMatrix4(
        visual.group.matrix
    );
}

// ==========================================
// ROOM CAPTURE META
// ==========================================

async function initiateRoomCapture() {
    if (!session || !isRunning) return;

    if (roomCaptureAttempted) {
        messageElement.textContent =
            "Room Capture a déjà été demandée pendant cette session.";

        return;
    }

    roomCaptureAttempted = true;

    if (typeof session.initiateRoomCapture !== "function") {
        roomCaptureStatus =
            "API initiateRoomCapture indisponible.";

        messageElement.textContent =
            "Room Capture indisponible dans cette session.";

        return;
    }

    roomCaptureStatus = "Demande de capture envoyée.";

    messageElement.textContent =
        "🤘 Demande de capture envoyée à Meta Quest.";

    try {
        const result = session.initiateRoomCapture();

        if (result && typeof result.then === "function") {
            await result;
        }

        roomCaptureStatus =
            "Demande envoyée.";

        messageElement.textContent =
            "Termine la capture si une interface Meta apparaît.";

    } catch (error) {
        roomCaptureStatus =
            "Erreur Room Capture : " + error.message;

        messageElement.textContent =
            roomCaptureStatus;

        console.error(error);
    }
}

// ==========================================
// DÉMARRAGE DU SCANNER
// ==========================================

async function enterAR() {
    startButton.disabled = true;

    messageElement.textContent =
        "Initialisation du scanner...";

    roomCaptureAttempted = false;
    roomCaptureStatus = "En attente";

    latestPlaneCount = 0;
    latestMeshCount = 0;

    maxDistance = DEFAULT_DISTANCE;

    openHandStart = null;
    adjustmentMode = false;
    controlHandedness = null;

    isPinching = false;
    previousPinchX = null;

    rockStartTime = null;
    rockDetected = false;

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
            scene.background = new THREE.Color(0x000000);

            camera = new THREE.PerspectiveCamera(
                70,
                window.innerWidth / window.innerHeight,
                0.01,
                100
            );
        }

        renderer.xr.setReferenceSpaceType(referenceType);

        renderer.setClearColor(0x000000, 1);
        renderer.setClearAlpha(1);

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

        logCapabilities();

        if (enabledFeatures.includes("hand-tracking")) {
            messageElement.textContent =
                "Ouvre une main pendant 5 secondes pour régler les couleurs.";
        } else {
            messageElement.textContent =
                "Hand Tracking indisponible. Vérifie les autorisations du Quest.";
        }

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
// RENDU
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

    updateSensitivityGesture(
        frame,
        viewerPose,
        time
    );

    updateRockGesture(frame, time);

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

// ==========================================
// NETTOYAGE
// ==========================================

function disposeScene() {
    if (!scene) return;

    for (const visual of planeVisuals.values()) {
        scene.remove(visual.group);
        visual.mesh.geometry.dispose();
        visual.mesh.material.dispose();
    }

    for (const visual of meshVisuals.values()) {
        scene.remove(visual.group);
        visual.mesh.geometry.dispose();
        visual.mesh.material.dispose();
    }

    planeVisuals.clear();
    meshVisuals.clear();

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
        `Plans conservés : ${planeVisuals.size}\n` +
        `Maillages conservés : ${meshVisuals.size}\n` +
        `Portée des couleurs : ${maxDistance.toFixed(1)} m\n` +
        `Fonctionnalités : ${enabledFeatures.join(", ") || "non communiquées"}`;

    console.info("RAPPORT FINAL DU SCAN");
    console.info(report);

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
