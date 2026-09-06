'use client';

import React, { useEffect, useRef, useState, useCallback } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export interface RoomPlacedItem {
  uid: string;
  item: {
    id: string;
    name: string;
    category: 'base' | 'overhead' | 'tall' | 'appliance' | 'tub' | 'lining';
    widthMm: number;
    heightMm: number;
    depthMm: number;
    priceNzd: number;
    sku: string;
    imageUrl?: string;
  };
}

interface ThreeRoomViewerProps {
  wallWidthMm: number;
  placedItems: RoomPlacedItem[];
  finishHex: string;
  finishName: string;
  benchtopPrice: number;
  handleStyle: string;
  onRemoveItem?: (uid: string) => void;
}

/** Generate realistic procedural woodgrain canvas texture */
function createWoodTexture(baseHex: string, grainHex: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;
  
  ctx.fillStyle = baseHex;
  ctx.fillRect(0, 0, 512, 512);

  // Draw subtle wood grain lines
  ctx.strokeStyle = grainHex;
  ctx.lineWidth = 1.5;
  for (let i = 0; i < 60; i++) {
    const y = Math.random() * 512;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.bezierCurveTo(
      150, y + (Math.random() * 16 - 8),
      350, y + (Math.random() * 16 - 8),
      512, y + (Math.random() * 12 - 6)
    );
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1, 2);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Generate realistic stone benchtop texture */
function createStoneTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;
  
  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(0, 0, 512, 512);

  // Subtle speckled stone aggregate
  for (let i = 0; i < 400; i++) {
    const x = Math.random() * 512;
    const y = Math.random() * 512;
    const r = Math.random() * 1.5 + 0.5;
    ctx.fillStyle = Math.random() > 0.5 ? 'rgba(203, 213, 225, 0.4)' : 'rgba(148, 163, 184, 0.25)';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2, 2);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export default function ThreeRoomViewer({
  wallWidthMm,
  placedItems,
  finishHex,
  finishName,
  handleStyle,
  onRemoveItem,
}: ThreeRoomViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const roomGroupRef = useRef<THREE.Group | null>(null);
  const interactiveMeshesRef = useRef<Map<THREE.Object3D, RoomPlacedItem>>(new Map());

  const [activeCameraView, setActiveCameraView] = useState<'iso' | 'front' | 'top' | 'side'>('iso');
  const [selectedCabinet, setSelectedCabinet] = useState<RoomPlacedItem | null>(null);
  const [openDoors, setOpenDoors] = useState<Set<string>>(new Set());

  // Initialize Three.js Scene with Studio Architectural Lighting
  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;
    const width = container.clientWidth || 600;
    const height = container.clientHeight || 360;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf1f5f9);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(36, width / height, 0.1, 100);
    camera.position.set(2.0, 1.8, 3.6);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    rendererRef.current = renderer;

    container.innerHTML = '';
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.maxPolarAngle = Math.PI / 2 + 0.02;
    controls.minDistance = 1.2;
    controls.maxDistance = 7.0;
    controls.target.set(0, 0.85, 0);
    controlsRef.current = controls;

    // ── Architectural Studio Lighting (Balanced & Natural) ──
    const ambientLight = new THREE.HemisphereLight(0xffffff, 0xe2e8f0, 0.95);
    scene.add(ambientLight);

    // Primary Sunlight Key
    const keyLight = new THREE.DirectionalLight(0xfffaf0, 1.4);
    keyLight.position.set(3.5, 4.5, 3.2);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.width = 2048;
    keyLight.shadow.mapSize.height = 2048;
    keyLight.shadow.bias = -0.0003;
    keyLight.shadow.camera.near = 0.5;
    keyLight.shadow.camera.far = 15;
    keyLight.shadow.camera.left = -3;
    keyLight.shadow.camera.right = 3;
    keyLight.shadow.camera.top = 3;
    keyLight.shadow.camera.bottom = -1;
    scene.add(keyLight);

    // Soft Skylight Fill
    const fillLight = new THREE.DirectionalLight(0xdbeafe, 0.55);
    fillLight.position.set(-3.5, 3.0, 2.0);
    scene.add(fillLight);

    // Floor Base (Neutral Modern Porcelain Tile)
    const floorGeo = new THREE.PlaneGeometry(8, 8);
    const floorMat = new THREE.MeshStandardMaterial({
      color: 0xe2e8f0,
      roughness: 0.35,
      metalness: 0.05,
    });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);

    // Grid Floor Overlay
    const grid = new THREE.GridHelper(8, 16, 0x002855, 0xcbd5e1);
    grid.position.y = 0.001;
    scene.add(grid);

    // Room Group
    const roomGroup = new THREE.Group();
    scene.add(roomGroup);
    roomGroupRef.current = roomGroup;

    // Raycaster for Click-to-Select Cabinets
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();

    const handleClick = (e: MouseEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(mouse, camera);
      const intersects = raycaster.intersectObjects(roomGroup.children, true);

      if (intersects.length > 0) {
        let curr: THREE.Object3D | null = intersects[0].object;
        while (curr && curr !== roomGroup && !interactiveMeshesRef.current.has(curr)) {
          curr = curr.parent;
        }
        if (curr && interactiveMeshesRef.current.has(curr)) {
          setSelectedCabinet(interactiveMeshesRef.current.get(curr) || null);
          return;
        }
      }
      setSelectedCabinet(null);
    };

    renderer.domElement.addEventListener('click', handleClick);

    // Animation Loop
    let animId: number;
    const animate = () => {
      animId = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    const handleResize = () => {
      if (!containerRef.current || !renderer || !camera) return;
      const w = containerRef.current.clientWidth;
      const h = containerRef.current.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener('resize', handleResize);

    return () => {
      renderer.domElement.removeEventListener('click', handleClick);
      window.removeEventListener('resize', handleResize);
      cancelAnimationFrame(animId);
      renderer.dispose();
    };
  }, []);

  // Update 3D Geometry when placedItems, wallWidth, or finishes change
  useEffect(() => {
    if (!roomGroupRef.current || !sceneRef.current) return;
    const group = roomGroupRef.current;
    interactiveMeshesRef.current.clear();

    // Clear old objects
    while (group.children.length > 0) {
      const obj = group.children[0];
      group.remove(obj);
      if ((obj as THREE.Mesh).geometry) (obj as THREE.Mesh).geometry.dispose();
    }

    const wallW = wallWidthMm / 1000;
    const wallH = 2.4;

    // 1. Back Wall (Clean architectural GIB Aqualine wall)
    const wallGeo = new THREE.BoxGeometry(wallW + 0.2, wallH, 0.05);
    const wallMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.9,
    });
    const wall = new THREE.Mesh(wallGeo, wallMat);
    wall.position.set(0, wallH / 2, -0.025);
    wall.receiveShadow = true;
    group.add(wall);

    // Subtle Subway Splashback Tile Area
    const splashGeo = new THREE.PlaneGeometry(wallW, 0.65);
    const splashMat = new THREE.MeshStandardMaterial({
      color: 0xf8fafc,
      roughness: 0.15,
      metalness: 0.08,
    });
    const splash = new THREE.Mesh(splashGeo, splashMat);
    splash.position.set(0, 1.22, 0.002);
    splash.receiveShadow = true;
    group.add(splash);

    // 2. Materials Setup
    const isWood = finishName.includes('Oak') || finishName.includes('Elm');
    const woodTex = isWood
      ? createWoodTexture(finishHex, finishName.includes('Oak') ? '#8a6840' : '#6b6357')
      : null;

    const cabinetMat = new THREE.MeshStandardMaterial({
      color: isWood ? 0xffffff : new THREE.Color(finishHex),
      map: woodTex,
      roughness: finishName.includes('Gloss') ? 0.12 : 0.65,
      metalness: finishName.includes('Gloss') ? 0.08 : 0.02,
    });

    const stoneTex = createStoneTexture();
    const korduraBenchMat = new THREE.MeshStandardMaterial({
      map: stoneTex,
      roughness: 0.28,
      metalness: 0.04,
    });

    const stainlessMat = new THREE.MeshStandardMaterial({
      color: 0xe2e8f0,
      roughness: 0.18,
      metalness: 0.88,
    });

    const handleMat = new THREE.MeshStandardMaterial({
      color: handleStyle.includes('Black') ? 0x111111 : 0xd97706,
      roughness: 0.3,
      metalness: 0.85,
    });

    // 3. Build Base Cabinets along Wall Run
    const baseItems = placedItems.filter((p) => p.item.category === 'base' || p.item.category === 'tall' || p.item.category === 'appliance' || p.item.category === 'tub');
    const overheadItems = placedItems.filter((p) => p.item.category === 'overhead');

    let currentX = -wallW / 2;

    baseItems.forEach((p) => {
      const itemW = p.item.widthMm / 1000;
      const itemH = (p.item.heightMm || 900) / 1000;
      const itemD = (p.item.depthMm || 600) / 1000;
      const posX = currentX + itemW / 2;

      const cabGroup = new THREE.Group();
      cabGroup.position.set(posX, 0, itemD / 2);
      interactiveMeshesRef.current.set(cabGroup, p);

      const isSelected = selectedCabinet?.uid === p.uid;
      const isOpen = openDoors.has(p.uid);

      if (p.item.category === 'appliance') {
        // Washing Machine / Dryer Cavity
        const washerGeo = new THREE.BoxGeometry(itemW - 0.04, 0.85, itemD - 0.04);
        const washerMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.25 });
        const washer = new THREE.Mesh(washerGeo, washerMat);
        washer.position.set(0, 0.85 / 2, 0);
        washer.castShadow = true;
        cabGroup.add(washer);

        // Glass Front Door
        const doorGeo = new THREE.CylinderGeometry(0.19, 0.19, 0.02, 32);
        const doorMat = new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.1, metalness: 0.9 });
        const door = new THREE.Mesh(doorGeo, doorMat);
        door.rotation.x = Math.PI / 2;
        door.position.set(0, 0.45, itemD / 2 - 0.015);
        cabGroup.add(door);
      } else if (p.item.category === 'tub') {
        // Robinhood SuperTub
        const tubGeo = new THREE.BoxGeometry(itemW - 0.02, itemH - 0.04, itemD - 0.02);
        const tubMesh = new THREE.Mesh(tubGeo, cabinetMat);
        tubMesh.position.set(0, (itemH - 0.04) / 2 + 0.02, 0);
        tubMesh.castShadow = true;
        cabGroup.add(tubMesh);

        // Stainless Sink Top
        const sinkTopGeo = new THREE.BoxGeometry(itemW, 0.04, itemD);
        const sinkTop = new THREE.Mesh(sinkTopGeo, stainlessMat);
        sinkTop.position.set(0, itemH - 0.01, 0);
        cabGroup.add(sinkTop);

        // Gooseneck Tapware
        const tapGeo = new THREE.TorusGeometry(0.08, 0.012, 16, 32, Math.PI);
        const tap = new THREE.Mesh(tapGeo, stainlessMat);
        tap.position.set(0, itemH + 0.16, -0.1);
        cabGroup.add(tap);
      } else {
        // Standard Base Cabinet / Starter Kit / Tall Tower
        const cabGeo = new THREE.BoxGeometry(itemW - 0.01, itemH - 0.04, itemD - 0.02);
        const cabMesh = new THREE.Mesh(cabGeo, cabinetMat);
        cabMesh.position.set(0, (itemH - 0.04) / 2 + 0.02, 0);
        cabMesh.castShadow = true;
        cabMesh.receiveShadow = true;
        cabGroup.add(cabMesh);

        // Black Shadow Toe-Kick Plinth
        const kickGeo = new THREE.BoxGeometry(itemW - 0.02, 0.08, itemD - 0.08);
        const kickMat = new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.95 });
        const kick = new THREE.Mesh(kickGeo, kickMat);
        kick.position.set(0, 0.04, -0.03);
        cabGroup.add(kick);

        // Solid Stone Benchtop (unless tall tower)
        if (p.item.category !== 'tall') {
          const benchGeo = new THREE.BoxGeometry(itemW, 0.035, itemD + 0.02);
          const bench = new THREE.Mesh(benchGeo, korduraBenchMat);
          bench.position.set(0, itemH - 0.015, 0.01);
          bench.castShadow = true;
          cabGroup.add(bench);

          // Integrated Sink for Starter Kit
          if (p.item.id.includes('kit') || p.item.id.includes('sink')) {
            const sinkGeo = new THREE.BoxGeometry(itemW * 0.7, 0.01, itemD * 0.6);
            const sink = new THREE.Mesh(sinkGeo, stainlessMat);
            sink.position.set(0, itemH + 0.005, 0);
            cabGroup.add(sink);
          }
        }

        // Metal Door Handle
        const handleGeo = new THREE.BoxGeometry(0.12, 0.015, 0.02);
        const handle = new THREE.Mesh(handleGeo, handleMat);
        handle.position.set(0, itemH * 0.75, itemD / 2 + 0.01);
        cabGroup.add(handle);
      }

      // Selection Ring
      if (isSelected) {
        const boxGeo = new THREE.BoxGeometry(itemW + 0.04, itemH + 0.06, itemD + 0.06);
        const edges = new THREE.EdgesGeometry(boxGeo);
        const lineMat = new THREE.LineBasicMaterial({ color: 0xffb81c, linewidth: 3 });
        const wireframe = new THREE.LineSegments(edges, lineMat);
        wireframe.position.set(0, itemH / 2, 0);
        cabGroup.add(wireframe);
      }

      group.add(cabGroup);
      currentX += itemW;
    });

    // 4. Build Overhead Wall Cabinets
    let currentOverX = -wallW / 2 + 0.05;
    overheadItems.forEach((p) => {
      const itemW = p.item.widthMm / 1000;
      const itemH = (p.item.heightMm || 720) / 1000;
      const itemD = (p.item.depthMm || 350) / 1000;
      const posX = currentOverX + itemW / 2;

      const overGroup = new THREE.Group();
      overGroup.position.set(posX, 1.52 + itemH / 2, itemD / 2);
      interactiveMeshesRef.current.set(overGroup, p);

      const overGeo = new THREE.BoxGeometry(itemW - 0.01, itemH, itemD);
      const overMesh = new THREE.Mesh(overGeo, cabinetMat);
      overMesh.castShadow = true;
      overGroup.add(overMesh);

      // Handle
      const hGeo = new THREE.BoxGeometry(0.1, 0.015, 0.02);
      const hMesh = new THREE.Mesh(hGeo, handleMat);
      hMesh.position.set(0, -itemH / 2 + 0.08, itemD / 2 + 0.01);
      overGroup.add(hMesh);

      if (selectedCabinet?.uid === p.uid) {
        const boxGeo = new THREE.BoxGeometry(itemW + 0.04, itemH + 0.06, itemD + 0.06);
        const edges = new THREE.EdgesGeometry(boxGeo);
        const lineMat = new THREE.LineBasicMaterial({ color: 0xffb81c, linewidth: 3 });
        const wireframe = new THREE.LineSegments(edges, lineMat);
        overGroup.add(wireframe);
      }

      group.add(overGroup);
      currentOverX += itemW;
    });
  }, [placedItems, wallWidthMm, finishHex, finishName, handleStyle, selectedCabinet, openDoors]);

  // Camera Presets
  const setCameraAngle = (view: 'iso' | 'front' | 'top' | 'side') => {
    setActiveCameraView(view);
    if (!cameraRef.current || !controlsRef.current) return;
    const camera = cameraRef.current;
    const controls = controlsRef.current;

    if (view === 'iso') {
      camera.position.set(1.8, 2.0, 3.4);
      controls.target.set(0, 0.9, 0);
    } else if (view === 'front') {
      camera.position.set(0, 1.1, 3.0);
      controls.target.set(0, 1.1, 0);
    } else if (view === 'top') {
      camera.position.set(0, 4.0, 0.1);
      controls.target.set(0, 0, 0);
    } else if (view === 'side') {
      camera.position.set(3.0, 1.2, 0.4);
      controls.target.set(0, 0.9, 0);
    }
  };

  const toggleDoor = useCallback((uid: string) => {
    setOpenDoors((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
  }, []);

  return (
    <div style={{ position: 'relative', width: '100%', height: '360px', borderRadius: '0.75rem', overflow: 'hidden', background: '#f1f5f9' }}>
      {/* 3D WebGL Canvas */}
      <div ref={containerRef} style={{ width: '100%', height: '100%', cursor: 'grab' }} />

      {/* Floating 3D Camera Controls */}
      <div
        style={{
          position: 'absolute',
          top: '12px',
          right: '12px',
          display: 'flex',
          gap: '4px',
          background: 'rgba(0, 40, 85, 0.88)',
          backdropFilter: 'blur(8px)',
          padding: '4px',
          borderRadius: '8px',
          border: '1px solid rgba(255,255,255,0.2)',
          zIndex: 10,
        }}
      >
        <button
          type="button"
          onClick={() => setCameraAngle('iso')}
          style={{
            padding: '5px 9px',
            fontSize: '11px',
            fontWeight: 700,
            borderRadius: '4px',
            border: 'none',
            background: activeCameraView === 'iso' ? '#FFB81C' : 'transparent',
            color: activeCameraView === 'iso' ? '#002855' : '#ffffff',
            cursor: 'pointer',
          }}
        >
          3D Orbit
        </button>
        <button
          type="button"
          onClick={() => setCameraAngle('front')}
          style={{
            padding: '5px 9px',
            fontSize: '11px',
            fontWeight: 700,
            borderRadius: '4px',
            border: 'none',
            background: activeCameraView === 'front' ? '#FFB81C' : 'transparent',
            color: activeCameraView === 'front' ? '#002855' : '#ffffff',
            cursor: 'pointer',
          }}
        >
          Front
        </button>
        <button
          type="button"
          onClick={() => setCameraAngle('top')}
          style={{
            padding: '5px 9px',
            fontSize: '11px',
            fontWeight: 700,
            borderRadius: '4px',
            border: 'none',
            background: activeCameraView === 'top' ? '#FFB81C' : 'transparent',
            color: activeCameraView === 'top' ? '#002855' : '#ffffff',
            cursor: 'pointer',
          }}
        >
          Top Plan
        </button>
        <button
          type="button"
          onClick={() => setCameraAngle('side')}
          style={{
            padding: '5px 9px',
            fontSize: '11px',
            fontWeight: 700,
            borderRadius: '4px',
            border: 'none',
            background: activeCameraView === 'side' ? '#FFB81C' : 'transparent',
            color: activeCameraView === 'side' ? '#002855' : '#ffffff',
            cursor: 'pointer',
          }}
        >
          Side
        </button>
      </div>

      {/* Selected Cabinet Action Overlay HUD */}
      {selectedCabinet && (
        <div
          style={{
            position: 'absolute',
            top: '12px',
            left: '12px',
            background: 'rgba(15, 23, 42, 0.92)',
            backdropFilter: 'blur(10px)',
            color: '#ffffff',
            padding: '10px 14px',
            borderRadius: '8px',
            border: '1px solid #FFB81C',
            zIndex: 10,
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            boxShadow: '0 8px 16px rgba(0,0,0,0.3)',
          }}
        >
          <div>
            <div style={{ fontSize: '11px', color: '#FFB81C', fontWeight: 800, textTransform: 'uppercase' }}>Selected Unit</div>
            <div style={{ fontSize: '13px', fontWeight: 800 }}>{selectedCabinet.item.name}</div>
            <div style={{ fontSize: '11px', color: '#94a3b8' }}>
              {selectedCabinet.item.widthMm}mm Width · SKU: {selectedCabinet.item.sku} · ${selectedCabinet.item.priceNzd} NZD
            </div>
          </div>

          <div style={{ display: 'flex', gap: '6px' }}>
            <button
              type="button"
              onClick={() => toggleDoor(selectedCabinet.uid)}
              style={{
                padding: '5px 10px',
                background: openDoors.has(selectedCabinet.uid) ? '#38bdf8' : 'rgba(255,255,255,0.15)',
                color: openDoors.has(selectedCabinet.uid) ? '#002855' : '#ffffff',
                border: 'none',
                borderRadius: '4px',
                fontSize: '11px',
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              {openDoors.has(selectedCabinet.uid) ? '🚪 Close Door' : '🚪 Open Door'}
            </button>
            {onRemoveItem && (
              <button
                type="button"
                onClick={() => {
                  onRemoveItem(selectedCabinet.uid);
                  setSelectedCabinet(null);
                }}
                style={{
                  padding: '5px 10px',
                  background: '#ef4444',
                  color: '#ffffff',
                  border: 'none',
                  borderRadius: '4px',
                  fontSize: '11px',
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                🗑️ Remove
              </button>
            )}
          </div>
        </div>
      )}

      {/* 3D Interaction Hint Badge */}
      <div
        style={{
          position: 'absolute',
          bottom: '10px',
          left: '10px',
          background: 'rgba(15, 23, 42, 0.85)',
          color: '#ffffff',
          padding: '5px 12px',
          borderRadius: '20px',
          fontSize: '11px',
          fontWeight: 600,
          pointerEvents: 'none',
          backdropFilter: 'blur(6px)',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          border: '1px solid rgba(255,255,255,0.1)',
        }}
      >
        <span>💡 Click any cabinet to inspect/remove · Drag to rotate 360° · Real-time {finishName}</span>
      </div>
    </div>
  );
}
