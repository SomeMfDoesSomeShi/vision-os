
import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";

// ==========================================
// CONFIGURATION
// ==========================================

const MAX_DISTANCE = 6;

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
let usingUnbounded = false;

const planeVisuals = new Map();
const meshVisuals = new Map();

// ==========================================
// DEPTH SHADER
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
                value: MAX_DISTANCE
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
// SUPPORT WEBXR
// ==========================================

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

// ==========================================
// GÉOMÉTRIE DES PLANS
// ==========================================

function createPlaneGeometry(polygon) {
    const vertices = polygon.map(p =>
        new THREE.Vector3(p.x, p.y, p.z)
    );

    const positions = [];

    for (const p of vertices) {
        positions.push(p.x, p.y, p.z);
    }

    const indices = [];

    for (let i = 1; i < vertices.length - 1; i++) {
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

function polygonSignature(polygon) {
    return polygon.map(p =>
        `${p.x.toFixed(4)},${p.y.toFixed(4)},${p.z.toFixed(4)}`
    ).join(";");
}

// ==========================================
// PLANS DÉTECTÉS
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
        signature: polygonSignature(plane.polygon)
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

    const signature = polygonSignature(plane.polygon);

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
// MAILLAGES 3D DÉTECTÉS
// ==========================================

function createMeshVisual() {
    const group = new THREE.Group();

    const geometry = new THREE.BufferGeometry();

    const mesh = new THREE.Mesh(
        geometry,
        createDepthMaterial()
    );

    group.add(mesh);
    group.matrixAutoUpdate = false;

    scene.add(group);

    return {
        group,
        mesh,
        vertexCount: 0,
        indexCount: 0
    };
}

function updateMeshGeometry(visual, xrMesh) {
    const vertices = xrMesh.vertices;
    const indices = xrMesh.indices;

    if (!vertices || vertices.length < 9) {
        return false;
    }

    if (!indices || indices.length < 3) {
        return false;
    }

    const geometry = visual.mesh.geometry;

    const vertexCount = vertices.length / 3;

    // Recréer les attributs uniquement si leur taille change.

    if (visual.vertexCount !== vertexCount) {
        geometry.setAttribute(
            "position",
            new THREE.BufferAttribute(
                new Float32Array(vertices.length),
                3
            )
        );

        visual.vertexCount = vertexCount;
    }

    // Actualiser les positions des sommets.

    const position = geometry.getAttribute("position");

    position.array.set(vertices);
    position.needsUpdate = true;

    // Actualiser les indices si nécessaire.

    if (visual.indexCount !== indices.length) {
        geometry.setIndex(
            new THREE.BufferAttribute(
                new Uint32Array(indices.length),
                1
            )
        );

        visual.indexCount = indices.length;
    }

    geometry.getIndex().array.set(indices);
    geometry.getIndex().needsUpdate = true;

    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();

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

    const updated = updateMeshGeometry(
        visual,
        xrMesh
    );

    if (!updated) return null;

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

    return sphere.center.clone()
        .applyMatrix4(visual.group.matrix);
}

// ==========================================
// SUPPRESSION DES ÉLÉMENTS
// ==========================================

function removeVisual(map, item) {
    const visual = map.get(item);

    if (!visual) return;

    scene.remove(visual.group);

    visual.mesh.geometry.dispose();
    visual.mesh.material.dispose();

    map.delete(item);
}

// ==========================================
// DÉMARRAGE
// ==========================================

async function enterAR() {
    startButton.disabled = true;

    messageElement.textContent =
        "Initialisation de la reconstruction 3D...";

    try {
        session = await navigator.xr.requestSession(
            "immersive-ar",
            {
                requiredFeatures: ["local-floor"],

                optionalFeatures: [
                    "plane-detection",
                    "mesh-detection",
                    "hand-tracking"
                ]
            }
        );

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

        // Essayer de conserver un repère spatial
        // qui ne soit pas limité à local-floor.

        renderer.xr.setReferenceSpaceType("unbounded");

        renderer.setClearColor(0x000000, 1);
        renderer.setClearAlpha(1);

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

        // Fallback si le navigateur ne prend pas
        // en charge le repère unbounded.

        try {
            await renderer.xr.setSession(session);
            usingUnbounded = true;

        } catch (unboundedError) {
            console.warn(
                "Unbounded indisponible, utilisation de local-floor.",
                unboundedError
            );

            renderer.xr.setReferenceSpaceType("local-floor");

            await renderer.xr.setSession(session);
            usingUnbounded = false;
        }

        referenceSpace = renderer.xr.getReferenceSpace();

        if (!referenceSpace) {
            throw new Error("Espace de référence indisponible.");
        }

        document.body.classList.add("xr-active");

        isRunning = true;

        const features = session.enabledFeatures
            ? Array.from(session.enabledFeatures)
            : [];

        const meshAvailable = features.includes("mesh-detection");

        statusElement.textContent = "Scanner actif";

        messageElement.textContent = meshAvailable
            ? "Reconstruction des maillages et des plans."
            : "Plans détectés uniquement : mesh-detection indisponible.";

        session.addEventListener("end", stopAR);

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
            renderer.dispose();
            renderer.domElement.remove();
            renderer = null;
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

    let nearestDistance = Infinity;

    // Plans.

    const planes = frame.detectedPlanes
        ? Array.from(frame.detectedPlanes)
        : [];

    for (const plane of planes) {
        const center = updatePlane(plane, frame);

        if (center) {
            nearestDistance = Math.min(
                nearestDistance,
                viewerPosition.distanceTo(center)
            );
        }
    }

    // Maillages 3D.

    const meshes = frame.detectedMeshes
        ? Array.from(frame.detectedMeshes)
        : [];

    for (const xrMesh of meshes) {
        const center = updateDetectedMesh(xrMesh, frame);

        if (center) {
            nearestDistance = Math.min(
                nearestDistance,
                viewerPosition.distanceTo(center)
            );
        }
    }

    // Nettoyage des éléments disparus.

    for (const plane of planeVisuals.keys()) {
        if (!planes.includes(plane)) {
            removeVisual(planeVisuals, plane);
        }
    }

    for (const mesh of meshVisuals.keys()) {
        if (!meshes.includes(mesh)) {
            removeVisual(meshVisuals, mesh);
        }
    }

    // Tableau de bord.

    planeCountElement.textContent =
        planes.length + meshes.length;

    nearestDistanceElement.textContent =
        Number.isFinite(nearestDistance)
            ? nearestDistance.toFixed(2)
            : "—";

    renderer.render(scene, camera);
}

// ==========================================
// ARRÊT
// ==========================================

function stopAR() {
    isRunning = false;

    if (renderer) {
        renderer.setAnimationLoop(null);
        renderer.dispose();
        renderer.domElement.remove();
        renderer = null;
    }

    for (const plane of planeVisuals.keys()) {
        removeVisual(planeVisuals, plane);
    }

    for (const mesh of meshVisuals.keys()) {
        removeVisual(meshVisuals, mesh);
    }

    planeVisuals.clear();
    meshVisuals.clear();

    if (scene) scene.clear();

    session = null;
    referenceSpace = null;
    scene = null;
    camera = null;

    document.body.classList.remove("xr-active");

    startButton.disabled = false;

    statusElement.textContent = "Scanner arrêté";
    messageElement.textContent = "Tu peux relancer le scanner.";

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

startButton.addEventListener("click", enterAR);

checkSupport();
