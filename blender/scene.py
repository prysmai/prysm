# PRYSM hero, built from scratch in Blender: a faceless mannequin in a white silk shroud stands in front of a gold
# coin. The coin's face carries the PRYSM mark in relief (traced from brand/logo-black.png by trace_logo.py), a
# beaded rim, a ray band and a lettered ring. The shroud and the cowl are real cloth simulations dropped onto the body.
#
#   blender -b -P scene.py -- --out renders/hero.png                     final still (1440 x 1688)
#   blender -b -P scene.py -- --out renders/prev.png --res 540x633 --samples 32
#   extra: --resim (redo the cloth instead of using cloth.blend), --spin N --frames DIR (N frames, one coin turn)
import bpy, bmesh, math, sys, json, os, random
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
def arg(name, default=None):
    return argv[argv.index(name) + 1] if name in argv else default
OUT = arg("--out", os.path.join(HERE, "renders/hero.png"))
RES = [int(x) for x in arg("--res", "1440x1688").split("x")]
SAMPLES = int(arg("--samples", "160"))
CLOTH = os.path.join(HERE, "cloth.blend")
random.seed(7)

bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
C = bpy.context

def link(o):
    sc.collection.objects.link(o); return o

def active(o):
    for s in C.selected_objects: s.select_set(False)
    o.select_set(True); C.view_layer.objects.active = o

def new_mesh(name, bm):
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    return link(bpy.data.objects.new(name, me))

def smooth(o):
    for p in o.data.polygons: p.use_smooth = True

# ---------------------------------------------------------------- materials
def nodes_mat(name):
    m = bpy.data.materials.new(name); m.use_nodes = True
    nt = m.node_tree
    return m, nt, nt.nodes, nt.links, nt.nodes["Principled BSDF"]

def gold(name, rough_lo, rough_hi, dirt, guilloche=False, patina=0.0, glow=False):
    m, nt, N, L, b = nodes_mat(name)
    b.inputs["Metallic"].default_value = 1.0
    tc = N.new("ShaderNodeTexCoord")
    nz = N.new("ShaderNodeTexNoise"); nz.inputs["Scale"].default_value = 9; nz.inputs["Detail"].default_value = 8
    L.new(tc.outputs["Object"], nz.inputs["Vector"])
    rr = N.new("ShaderNodeMapRange"); rr.inputs["To Min"].default_value = rough_lo; rr.inputs["To Max"].default_value = rough_hi
    L.new(nz.outputs["Fac"], rr.inputs["Value"]); L.new(rr.outputs["Result"], b.inputs["Roughness"])
    # dirt in the recesses: ambient occlusion pulls the gold toward a dark bronze
    ao = N.new("ShaderNodeAmbientOcclusion"); ao.inputs["Distance"].default_value = 0.02
    mix = N.new("ShaderNodeMix"); mix.data_type = "RGBA"
    mix.inputs["A"].default_value = (0.16, 0.08, 0.025, 1); mix.inputs["B"].default_value = (1.0, 0.7, 0.3, 1)
    pw = N.new("ShaderNodeMath"); pw.operation = "POWER"; pw.inputs[1].default_value = dirt
    L.new(ao.outputs["AO"], pw.inputs[0]); L.new(pw.outputs[0], mix.inputs["Factor"])
    pn = N.new("ShaderNodeTexNoise"); pn.inputs["Scale"].default_value = 3.5; pn.inputs["Detail"].default_value = 10; pn.inputs["Roughness"].default_value = 0.65
    L.new(tc.outputs["Object"], pn.inputs["Vector"])
    pr = N.new("ShaderNodeMapRange"); pr.inputs["From Min"].default_value = 0.45; pr.inputs["From Max"].default_value = 0.62
    pr.inputs["To Min"].default_value = 0; pr.inputs["To Max"].default_value = patina
    L.new(pn.outputs["Fac"], pr.inputs["Value"])
    pm = N.new("ShaderNodeMix"); pm.data_type = "RGBA"; pm.inputs["B"].default_value = (0.09, 0.05, 0.02, 1)
    L.new(mix.outputs["Result"], pm.inputs["A"]); L.new(pr.outputs["Result"], pm.inputs["Factor"])
    L.new(pm.outputs["Result"], b.inputs["Base Color"])
    # fine brushed grain
    gr = N.new("ShaderNodeTexNoise"); gr.inputs["Scale"].default_value = 900; gr.inputs["Detail"].default_value = 2
    L.new(tc.outputs["Object"], gr.inputs["Vector"])
    bump = N.new("ShaderNodeBump"); bump.inputs["Strength"].default_value = 0.06; bump.inputs["Distance"].default_value = 0.0005
    L.new(gr.outputs["Fac"], bump.inputs["Height"]); L.new(bump.outputs["Normal"], b.inputs["Normal"])
    if glow:
        ln = N.new("ShaderNodeVectorMath"); ln.operation = "LENGTH"; L.new(tc.outputs["Object"], ln.inputs[0])
        sw = N.new("ShaderNodeValue"); sw.name = "sweep"; sw.outputs[0].default_value = -1
        lt = N.new("ShaderNodeMath"); lt.operation = "LESS_THAN"; L.new(ln.outputs["Value"], lt.inputs[0]); L.new(sw.outputs[0], lt.inputs[1])
        gv = N.new("ShaderNodeValue"); gv.name = "glow"; gv.outputs[0].default_value = 0
        ml = N.new("ShaderNodeMath"); ml.operation = "MULTIPLY"; L.new(lt.outputs[0], ml.inputs[0]); L.new(gv.outputs[0], ml.inputs[1])
        b.inputs["Emission Color"].default_value = (1.0, 0.5, 0.16, 1); L.new(ml.outputs[0], b.inputs["Emission Strength"])
    if guilloche:
        # fine concentric engine turning, broken up by a slow wave, as on a struck medal
        wv = N.new("ShaderNodeTexWave"); wv.wave_type = "RINGS"; wv.inputs["Scale"].default_value = 60
        wv.inputs["Distortion"].default_value = 3; wv.inputs["Detail"].default_value = 2
        L.new(tc.outputs["Object"], wv.inputs["Vector"])
        b2 = N.new("ShaderNodeBump"); b2.inputs["Strength"].default_value = 0.35; b2.inputs["Distance"].default_value = 0.0008
        L.new(wv.outputs["Fac"], b2.inputs["Height"]); L.new(bump.outputs["Normal"], b2.inputs["Normal"])
        L.new(b2.outputs["Normal"], b.inputs["Normal"])
    return m

GOLD_FIELD = gold("gold_field", 0.2, 0.4, 2.6, guilloche=True, patina=0.75)
GOLD_RELIEF = gold("gold_relief", 0.08, 0.18, 1.2, patina=0.35, glow=True)

SKIN, _, _, _, sb = nodes_mat("mannequin")
sb.inputs["Base Color"].default_value = (0.018, 0.018, 0.02, 1); sb.inputs["Roughness"].default_value = 0.32
sb.inputs["Coat Weight"].default_value = 0.5; sb.inputs["Coat Roughness"].default_value = 0.12

SUIT, _, _, _, ub = nodes_mat("suit")
ub.inputs["Base Color"].default_value = (0.012, 0.012, 0.014, 1); ub.inputs["Roughness"].default_value = 0.45
ub.inputs["Metallic"].default_value = 0.3

SILK, _, sN, sL, kb = nodes_mat("silk")
kb.inputs["Base Color"].default_value = (0.72, 0.69, 0.62, 1); kb.inputs["Roughness"].default_value = 0.55
kb.inputs["Sheen Weight"].default_value = 0.6; kb.inputs["Sheen Roughness"].default_value = 0.35
kb.inputs["Subsurface Weight"].default_value = 0.08; kb.inputs["Subsurface Radius"].default_value = (0.02, 0.015, 0.01)

# ---------------------------------------------------------------- the coin, built flat (face +z) then stood up
R = 0.62
coin_parts = []

def disc(r_out, r_in, z0, z1, segs=256):
    bm = bmesh.new()
    if r_in <= 0:
        bmesh.ops.create_cone(bm, cap_ends=True, segments=segs, radius1=r_out, radius2=r_out, depth=z1 - z0)
        bmesh.ops.translate(bm, verts=bm.verts, vec=(0, 0, (z0 + z1) / 2))
        return bm
    # a flat ring: two circles, bridged, extruded
    outer = [bm.verts.new((r_out * math.cos(a), r_out * math.sin(a), z1)) for a in (2 * math.pi * i / segs for i in range(segs))]
    inner = [bm.verts.new((r_in * math.cos(a), r_in * math.sin(a), z1)) for a in (2 * math.pi * i / segs for i in range(segs))]
    for i in range(segs):
        j = (i + 1) % segs
        bm.faces.new((outer[i], outer[j], inner[j], inner[i]))
    ext = bmesh.ops.extrude_face_region(bm, geom=bm.faces[:])
    vs = [g for g in ext["geom"] if isinstance(g, bmesh.types.BMVert)]
    bmesh.ops.translate(bm, verts=vs, vec=(0, 0, z0 - z1))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    return bm

def bevel_mod(o, w, segs=3):
    m = o.modifiers.new("bev", "BEVEL"); m.width = w; m.segments = segs; m.limit_method = "ANGLE"; m.harden_normals = False
    return m

body = new_mesh("coin_body", disc(R, 0, -0.05, 0.0)); body.data.materials.append(GOLD_FIELD); bevel_mod(body, 0.006); coin_parts.append(body)
rim = new_mesh("coin_rim", disc(R, R - 0.045, 0.0, 0.016)); rim.data.materials.append(GOLD_RELIEF); bevel_mod(rim, 0.005); coin_parts.append(rim)
inner_ring = new_mesh("coin_ring", disc(0.432, 0.42, 0.0, 0.007)); inner_ring.data.materials.append(GOLD_RELIEF); bevel_mod(inner_ring, 0.002, 2); coin_parts.append(inner_ring)
for i, r in enumerate((0.515, 0.505)):
    o = new_mesh(f"coin_line{i}", disc(r + 0.002, r - 0.002, 0.0, 0.004)); o.data.materials.append(GOLD_RELIEF); coin_parts.append(o)

# beaded ring just inside the rim
bm = bmesh.new()
for i in range(96):
    a = 2 * math.pi * i / 96
    g = bmesh.ops.create_uvsphere(bm, u_segments=10, v_segments=6, radius=0.0055)
    bmesh.ops.translate(bm, verts=g["verts"], vec=(0.562 * math.cos(a), 0.562 * math.sin(a), 0.0))
beads = new_mesh("coin_beads", bm); beads.data.materials.append(GOLD_RELIEF); smooth(beads); coin_parts.append(beads)

# rays between the mark and the lettered ring: long thin wedges, alternating length
bm = bmesh.new()
for i in range(72):
    a = 2 * math.pi * (i + 0.5) / 72
    r0, r1, w = 0.435, (0.495 if i % 2 else 0.47), 0.004
    t = Vector((math.cos(a), math.sin(a), 0)); n = Vector((-t.y, t.x, 0))
    p = [t * r0 + n * w, t * r1, t * r0 - n * w]
    vs = [bm.verts.new((v.x, v.y, 0.0)) for v in p] + [bm.verts.new((v.x, v.y, 0.004)) for v in p]
    bm.faces.new((vs[0], vs[1], vs[2])); bm.faces.new((vs[5], vs[4], vs[3]))
    for k in range(3):
        j = (k + 1) % 3
        bm.faces.new((vs[k], vs[3 + k], vs[3 + j], vs[j]))
bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
rays = new_mesh("coin_rays", bm); rays.data.materials.append(GOLD_RELIEF); coin_parts.append(rays)

# lettered ring, set on a clockwise path so it reads upright across the top
def ring_text(name, body, r_txt=0.531):
    path = bpy.data.curves.new(name + "_path", "CURVE"); path.dimensions = "2D"
    sp = path.splines.new("POLY"); n = 180; sp.points.add(n - 1); sp.use_cyclic_u = True
    for i in range(n):
        a = math.pi / 2 + 2.62 - 2 * math.pi * i / n          # starts left of top, runs clockwise
        sp.points[i].co = (r_txt * math.cos(a), r_txt * math.sin(a), 0, 1)
    path_o = link(bpy.data.objects.new(name + "_path", path))
    td = bpy.data.curves.new(name, "FONT"); td.body = body
    td.size = 0.026; td.space_character = 1.35; td.extrude = 0.0018; td.follow_curve = path_o
    o = link(bpy.data.objects.new(name, td))
    active(o); bpy.ops.object.convert(target="MESH")
    o.data.materials.append(GOLD_RELIEF); bpy.data.objects.remove(path_o)
    return o
txt = ring_text("ring_text", "PRYSM  ·  AGENT LEAGUE  ·  SEALED BEFORE THE MOVE  ·  ROBINHOOD CHAIN  ·  SEASON ZERO  ·")
coin_parts.append(txt)

# the PRYSM mark in relief
logo = json.load(open(os.path.join(HERE, "logo.json")))
cu = bpy.data.curves.new("mark", "CURVE"); cu.dimensions = "2D"; cu.fill_mode = "BOTH"
cu.extrude = 0.006; cu.bevel_depth = 0.0016; cu.bevel_resolution = 2
S = 0.405
for c in logo:
    s = cu.splines.new("POLY"); s.points.add(len(c["pts"]) - 1); s.use_cyclic_u = True
    for i, (x, y) in enumerate(c["pts"]):
        s.points[i].co = (x * S, y * S, 0, 1)
mark = link(bpy.data.objects.new("mark", cu)); mark.location.z = 0.006
active(mark); bpy.ops.object.convert(target="MESH")
mark.data.materials.append(GOLD_RELIEF); coin_parts.append(mark)

# the reverse: built face-up like the obverse, then turned over onto the back of the body
back_parts = []
for nm, (ro, ri, h) in {"b_rim": (R, R - 0.045, 0.016), "b_ring1": (0.432, 0.42, 0.007), "b_ring2": (0.3, 0.292, 0.005), "b_ring3": (0.17, 0.164, 0.005)}.items():
    o = new_mesh(nm, disc(ro, ri, 0.0, h)); o.data.materials.append(GOLD_RELIEF); bevel_mod(o, 0.002, 2); back_parts.append(o)
o = bpy.data.objects.new("b_beads", beads.data); link(o); back_parts.append(o)
back_parts.append(ring_text("b_text", "SCORED BY THE POOL  ·  TIME WEIGHTED PRICE  ·  UNISWAP V3  ·  ROBINHOOD CHAIN  ·  NO ORACLE  ·"))
# the price line: a raised wire across the face, a baseline and ticks under it
cv = bpy.data.curves.new("b_wave", "CURVE"); cv.dimensions = "3D"; cv.bevel_depth = 0.006; cv.bevel_resolution = 3
sp = cv.splines.new("POLY"); pts = 120; sp.points.add(pts - 1)
for i in range(pts):
    x = -0.36 + 0.72 * i / (pts - 1)
    y = 0.05 * math.sin(x * 11) + 0.035 * math.sin(x * 23 + 1) + 0.16 * x
    sp.points[i].co = (x, y, 0.006, 1)
wv = link(bpy.data.objects.new("b_wave", cv)); active(wv); bpy.ops.object.convert(target="MESH")
wv.data.materials.append(GOLD_RELIEF); back_parts.append(wv)
bm = bmesh.new()
for i in range(25):
    x = -0.36 + 0.03 * i; hh = 0.022 if i % 4 == 0 else 0.012
    g = bmesh.ops.create_cube(bm, size=1); bmesh.ops.scale(bm, vec=(0.004, hh, 0.006), verts=g["verts"])
    bmesh.ops.translate(bm, vec=(x, -0.2 - hh / 2, 0.003), verts=g["verts"])
g = bmesh.ops.create_cube(bm, size=1); bmesh.ops.scale(bm, vec=(0.74, 0.005, 0.006), verts=g["verts"]); bmesh.ops.translate(bm, vec=(0, -0.2, 0.003), verts=g["verts"])
tk = new_mesh("b_ticks", bm); tk.data.materials.append(GOLD_RELIEF); back_parts.append(tk)
back = link(bpy.data.objects.new("coin_back", None)); back.location.z = -0.05; back.rotation_euler.y = math.pi
for o in back_parts: o.parent = back

coin = link(bpy.data.objects.new("coin", None))
for o in coin_parts + [back]: o.parent = coin
coin.rotation_euler = (math.radians(84), 0, math.radians(-9))
coin.location = (0, 0.62, 1.93)

# ---------------------------------------------------------------- the mannequin
def ellipsoid(name, loc, size, mat, segs=48):
    bm = bmesh.new(); bmesh.ops.create_uvsphere(bm, u_segments=segs, v_segments=segs // 2, radius=1)
    bmesh.ops.scale(bm, vec=size, verts=bm.verts); bmesh.ops.translate(bm, vec=loc, verts=bm.verts)
    o = new_mesh(name, bm); o.data.materials.append(mat); smooth(o); return o

head = ellipsoid("head", (0, 0.0, 1.76), (0.112, 0.125, 0.152), SKIN)
head.rotation_euler.x = math.radians(-6)

# the body: overlapping ellipsoids fused by a voxel remesh, then smoothed
parts = [
    ellipsoid("p_neck", (0, 0.0, 1.56), (0.058, 0.058, 0.14), SUIT, 24),
    ellipsoid("p_chest", (0, 0.0, 1.27), (0.2, 0.125, 0.24), SUIT, 32),
    ellipsoid("p_yoke", (0, 0.0, 1.41), (0.22, 0.1, 0.07), SUIT, 32),
    ellipsoid("p_waist", (0, 0.0, 0.9), (0.165, 0.11, 0.34), SUIT, 32),
    ellipsoid("p_hips", (0, 0.0, 0.55), (0.18, 0.12, 0.3), SUIT, 32),
]
for sx in (-1, 1):
    parts += [ellipsoid("p_sh", (0.19 * sx, 0.0, 1.39), (0.08, 0.08, 0.075), SUIT, 24),
              ellipsoid("p_arm", (0.2 * sx, 0.0, 1.12), (0.055, 0.055, 0.24), SUIT, 24)]
for o in C.selected_objects: o.select_set(False)
for o in parts: o.select_set(True)
C.view_layer.objects.active = parts[0]; bpy.ops.object.join()
torso = C.view_layer.objects.active; torso.name = "torso"
rm = torso.modifiers.new("rm", "REMESH"); rm.mode = "VOXEL"; rm.voxel_size = 0.008
sm = torso.modifiers.new("sm", "SMOOTH"); sm.iterations = 12; sm.factor = 0.8
active(torso); bpy.ops.object.modifier_apply(modifier="rm"); bpy.ops.object.modifier_apply(modifier="sm"); smooth(torso)
neck_col = ellipsoid("neck_col", (0, 0, 1.55), (0.06, 0.06, 0.1), SKIN, 24)

# ---------------------------------------------------------------- cloth
def collider(o, thick=0.006):
    m = o.modifiers.new("col", "COLLISION"); o.collision.thickness_outer = thick; o.collision.cloth_friction = 12
    return m

def simulate(o, frames, pin=None, shrink=0.0, bend=0.08, self_col=True):
    cl = o.modifiers.new("cloth", "CLOTH"); s = cl.settings; cs = cl.collision_settings
    s.quality = 10; s.mass = 0.12; s.air_damping = 1.5
    s.tension_stiffness = 12; s.compression_stiffness = 12; s.shear_stiffness = 6; s.bending_stiffness = bend
    s.shrink_min = shrink
    if pin: s.vertex_group_mass = pin; s.pin_stiffness = 1
    cs.collision_quality = 4; cs.distance_min = 0.004
    cs.use_self_collision = self_col; cs.self_distance_min = 0.003; cs.self_friction = 8
    cl.point_cache.frame_start = 1; cl.point_cache.frame_end = frames
    sc.frame_start, sc.frame_end = 1, frames
    for f in range(1, frames + 1):
        sc.frame_set(f)
        if f % 10 == 0: print(f"  cloth {o.name}: frame {f}/{frames}", flush=True)
    dg = C.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(o.evaluated_get(dg))
    o.modifiers.clear(); old = o.data; o.data = me; bpy.data.meshes.remove(old)
    sc.frame_set(1)

def shroud():
    # a polar mesh: rings out from the neck to an oval hem, open in a slit up the front that widens toward the hem,
    # so every edge is a clean line. Pinned on the first rings round the neck.
    bm = bmesh.new(); U, V, r_in = 168, 64, 0.085
    ax, ay = 0.84, 1.1
    rows = []
    for j in range(V + 1):
        v = j / V
        half = 0.06 + 0.5 * v ** 1.6                                     # half the slit, in radians
        row = []
        for i in range(U + 1):
            th = -math.pi / 2 + half + (2 * math.pi - 2 * half) * i / U  # starts just right of the front, all the way round
            c, s_ = math.cos(th), math.sin(th)
            r_out = 1 / math.sqrt((c / ax) ** 2 + (s_ / ay) ** 2)
            r = r_in + (r_out - r_in) * v
            x, y = r * c, r * s_
            z = 1.62 + 0.012 * math.sin(th * 5) * v
            row.append(bm.verts.new((x, y - 0.04 * v, z)))
        rows.append(row)
    for j in range(V):
        for i in range(U):
            bm.faces.new((rows[j][i], rows[j][i + 1], rows[j + 1][i + 1], rows[j + 1][i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    o = new_mesh("shroud", bm)
    vg = o.vertex_groups.new(name="pin")
    vg.add([k for k in range(4 * (U + 1))], 1.0, "REPLACE")
    return o

def scarf():
    # three flat bands wound round the neck, higher at the back, each fluted with soft folds
    bm = bmesh.new(); NU, NV = 200, 14
    bands = ((1.625, 0.15, 0.07, 0.08, 0.0), (1.67, 0.134, 0.1, 0.07, 1.9))
    for zc, rr, tilt, hgt, ph in bands:
        grid = []
        for i in range(NU):
            a = 2 * math.pi * i / NU
            fold = math.sin(a * 7 + ph) * 0.6 + math.sin(a * 13 + ph * 2) * 0.25 + math.sin(a * 2 - ph) * 0.5
            cz = zc + tilt * 0.5 * (math.sin(a) + 1) - 0.03
            ring = []
            for j in range(NV):
                t = j / (NV - 1) - 0.5                                     # across the band, bottom to top
                flare = 0.018 * (t + 0.5) ** 2 + 0.008 * fold * math.cos(t * math.pi)
                r = rr + flare + 0.006 * math.sin(t * math.pi * 2 + a * 5 + ph)
                ring.append(bm.verts.new((r * math.cos(a), r * math.sin(a), cz + t * hgt)))
            grid.append(ring)
        for i in range(NU):
            for j in range(NV - 1):
                bm.faces.new((grid[i][j], grid[(i + 1) % NU][j], grid[(i + 1) % NU][j + 1], grid[i][j + 1]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    return new_mesh("cowl", bm)

def apply_finish(o):
    so = o.modifiers.new("thick", "SOLIDIFY"); so.thickness = 0.0035; so.offset = 0
    sub = o.modifiers.new("sub", "SUBSURF"); sub.levels = 2; sub.render_levels = 2
    o.data.materials.append(SILK); smooth(o)

if os.path.exists(CLOTH) and "--resim" not in argv:
    with bpy.data.libraries.load(CLOTH) as (src, dst):
        dst.meshes = [m for m in src.meshes if m in ("shroud_sim", "cowl_sim")]
    sh = link(bpy.data.objects.new("shroud", bpy.data.meshes["shroud_sim"]))
    cw = link(bpy.data.objects.new("cowl", bpy.data.meshes["cowl_sim"]))
else:
    for o in (head, torso, neck_col): collider(o)
    print("simulating the shroud", flush=True)
    sh = shroud(); simulate(sh, 140, pin="pin", bend=0.18)
    collider(sh, 0.01)
    cw = scarf()
    sh.data.name, cw.data.name = "shroud_sim", "cowl_sim"
    bpy.data.libraries.write(CLOTH, {sh.data, cw.data}, fake_user=True)
    for o in (head, torso, neck_col, sh):
        for m in [m for m in o.modifiers if m.type == "COLLISION"]: o.modifiers.remove(m)
bpy.data.objects.remove(neck_col)
apply_finish(sh)
apply_finish(cw)

# ---------------------------------------------------------------- light, camera, render
sc.render.engine = "CYCLES"
cy = sc.cycles
try:
    prefs = C.preferences.addons["cycles"].preferences; prefs.compute_device_type = "METAL"; prefs.get_devices()
    for d in prefs.devices: d.use = True
    cy.device = "GPU"
except Exception as e:
    print("GPU unavailable:", e)
cy.samples = SAMPLES; cy.use_denoising = True; cy.max_bounces = 8; cy.glossy_bounces = 6
sc.render.resolution_x, sc.render.resolution_y = RES; sc.render.resolution_percentage = 100
try: sc.view_settings.view_transform = "Khronos PBR Neutral"
except Exception: sc.view_settings.view_transform = "AgX"
sc.render.image_settings.file_format = "PNG"
sc.view_settings.exposure = -0.6

# the world: black to the camera, Blender's bundled studio HDRI for everything the gold reflects
import glob
world = bpy.data.worlds.new("w"); sc.world = world; world.use_nodes = True
wn, wl = world.node_tree.nodes, world.node_tree.links
bg = wn["Background"]; out = wn["World Output"]
env = wn.new("ShaderNodeTexEnvironment")
env.image = bpy.data.images.load(glob.glob(os.path.join(os.path.dirname(bpy.app.binary_path), "../Resources/*/datafiles/studiolights/world/" + arg("--hdri", "interior.exr")))[0])
mp = wn.new("ShaderNodeMapping"); tc = wn.new("ShaderNodeTexCoord"); mp.inputs["Rotation"].default_value[2] = math.radians(float(arg("--hdri-rot", "200")))
wl.new(tc.outputs["Generated"], mp.inputs["Vector"]); wl.new(mp.outputs["Vector"], env.inputs["Vector"])
tint = wn.new("ShaderNodeMix"); tint.data_type = "RGBA"; tint.blend_type = "MULTIPLY"; tint.inputs["Factor"].default_value = 1
tint.inputs["B"].default_value = (1.0, 0.8, 0.6, 1)
wl.new(env.outputs["Color"], tint.inputs["A"]); wl.new(tint.outputs["Result"], bg.inputs["Color"])
bg.inputs["Strength"].default_value = float(arg("--env", "0.35"))
lp = wn.new("ShaderNodeLightPath"); dark = wn.new("ShaderNodeBackground"); dark.inputs["Color"].default_value = (0.003, 0.0026, 0.003, 1)
mx = wn.new("ShaderNodeMixShader")
# the cloth and the mannequin see only a whisper of it; glossy bounces see all of it
gm = wn.new("ShaderNodeMath"); gm.operation = "MAXIMUM"
wl.new(lp.outputs["Is Camera Ray"], gm.inputs[0]); wl.new(lp.outputs["Is Diffuse Ray"], gm.inputs[1])
wl.new(gm.outputs[0], mx.inputs["Fac"])
wl.new(bg.outputs[0], mx.inputs[1]); wl.new(dark.outputs[0], mx.inputs[2]); wl.new(mx.outputs[0], out.inputs["Surface"])

def area(name, loc, aim, power, size, color=(1, 0.93, 0.84), shape="RECTANGLE", size_y=None):
    d = bpy.data.lights.new(name, "AREA"); d.energy = power; d.color = color; d.shape = shape
    d.size = size; d.size_y = size_y or size
    o = link(bpy.data.objects.new(name, d)); o.location = loc
    o.rotation_euler = (Vector(aim) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
    return o

area("key", (-2.4, -0.9, 2.9), (0, 0, 1.35), 95, 0.9, (1, 0.95, 0.9))
area("fill", (2.2, -2.6, 1.6), (0, 0, 1.3), 6, 2.4, (0.85, 0.88, 1.0))
area("rim", (0.0, 0.32, 2.35), (0, -0.1, 1.55), 40, 0.5, (1, 0.82, 0.6))
# soft strips the coin's relief reflects
area("strip_l", (-1.3, -1.6, 2.6), (0, 0.62, 1.93), 22, 0.35, (1, 0.86, 0.66), size_y=2.4)
area("strip_r", (1.4, -1.4, 0.9), (0, 0.62, 1.93), 14, 0.35, (1, 0.86, 0.66), size_y=2.0)
area("top", (0.0, -0.6, 3.2), (0, 0.62, 1.93), 14, 1.2, (1, 0.9, 0.75))
# a faint warm halo spilling round the coin's edge
d = bpy.data.lights.new("halo", "POINT"); d.energy = 25; d.color = (1, 0.6, 0.3); d.shadow_soft_size = 0.4
link(bpy.data.objects.new("halo", d)).location = (0, 0.9, 2.05)

cam_d = bpy.data.cameras.new("cam"); cam_d.lens = 80; cam_d.sensor_fit = "VERTICAL"; cam_d.sensor_height = 36
cam_d.dof.use_dof = True; cam_d.dof.aperture_fstop = 5.6
cam = link(bpy.data.objects.new("cam", cam_d)); sc.camera = cam
cam.location = (0, -4.0, 1.78)
target = Vector((0, 0, 1.68))
cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()
cam_d.dof.focus_distance = 4.0

# ---------------------------------------------------------------- morph states (storyboard)
def set_glow(sweep, glow):
    n = GOLD_RELIEF.node_tree.nodes; n["sweep"].outputs[0].default_value = sweep; n["glow"].outputs[0].default_value = glow

def orbit(count=20):
    # the season's top 20: small coins on a tilted ring round the figure
    src = [body.data, mark.data, rim.data]
    for i in range(count):
        a = 2 * math.pi * i / count + 0.2
        e = link(bpy.data.objects.new(f"orb{i}", None))
        e.location = (0.68 * math.cos(a), 0.1 + 0.5 * math.sin(a), 1.5 + 0.2 * math.sin(a + 0.6))
        e.rotation_euler = (math.radians(84), 0, math.radians(-25 * math.cos(a)) + a * 0.3)
        e.scale = (0.12,) * 3
        for d in src:
            o = link(bpy.data.objects.new(f"orb{i}_{d.name}", d)); o.parent = e
            if d is mark.data: o.location.z = 0.006

# close-ups of the coin for the sections under the hero: the figure steps out, the camera moves in
SHOTS = {  # state, camera position, aim (relative to the coin centre), lens, f-stop
    "seal":   ("face",      (-0.75, -1.2, -0.32), (0.04, 0, 0.04), 60, 2.8),
    "pool":   ("back",      (0.85, -1.35, 0.14),   (0.02, 0, 0.0), 58, 3.2),
    "write":  ("glow_mid",  (0.22, -1.4, 0.22),    (0.0, 0, 0.03), 66, 3.2),
    "season": ("layers",    (-1.55, -0.75, 0.4),   (0.0, 0.1, 0.0), 50, 5.0),
}
if "--shot" in argv:
    st, off, aim, lens, fs = SHOTS[arg("--shot")]
    for n in ("head", "torso", "shroud", "cowl"): bpy.data.objects[n].hide_render = True
    c0 = Vector(coin.location)
    cam.location = c0 + Vector(off); tgt = c0 + Vector(aim)
    cam.rotation_euler = (tgt - cam.location).to_track_quat("-Z", "Y").to_euler()
    cam_d.lens = lens; cam_d.dof.aperture_fstop = fs; cam_d.dof.focus_distance = (tgt - cam.location).length
    cam_d.sensor_fit = "HORIZONTAL"; cam_d.sensor_width = 36
    argv += ["--state", st]

STATE = arg("--state", "face")
base_z = coin.rotation_euler.z
if STATE == "edge": coin.rotation_euler.z = base_z + math.radians(78)
if STATE == "back": coin.rotation_euler.z = base_z + math.pi
if STATE == "glow_mid": set_glow(0.26, 5 if "--shot" in argv else 14)
if STATE == "glow_full": set_glow(0.75, 6)
if STATE == "layers":
    for o, dz, rz in ((mark, 0.32, 0), (inner_ring, 0.22, 0), (rays, 0.16, 18), (txt, 0.09, -30), (rim, -0.04, 0), (beads, -0.04, 12)):
        o.location.z += dz; o.rotation_euler.z = math.radians(rz)
    coin.rotation_euler = (math.radians(74), math.radians(-6), math.radians(-28))
if STATE == "orbit": orbit()

# ---------------------------------------------------------------- the hero morph: one loop through the four steps
# s runs 0..4: 0 face (01), 1 reverse (02), 2 engraving lit (03), 3 opened into layers (04), 4 = 0 again.
LAYERS = ((mark, 0.32, 0), (inner_ring, 0.22, 0), (rays, 0.16, 18), (txt, 0.09, -30), (rim, -0.04, 0), (beads, -0.04, 12))
REST = {o: (o.location.z, o.rotation_euler.z) for o, _, _ in LAYERS}
ROT0, ROT1 = (math.radians(84), 0, math.radians(-9)), (math.radians(74), math.radians(-6), math.radians(-28))
def ease(x):
    x = min(1.0, max(0.0, x)); return x * x * (3 - 2 * x)
def pose(s):
    s %= 4
    spin = math.pi * ease(s) if s < 1 else math.pi * (1 + ease(s - 1)) if s < 2 else 0.0
    if s < 1: sweep, glow = -1, 0
    elif s < 2: sweep, glow = -0.05 + 0.85 * ease((s - 1.35) / 0.6), 3.2 * ease((s - 1.3) / 0.3)
    elif s < 3: sweep, glow = 0.8, 3.2 * (1 - ease((s - 2) / 0.45))
    else: sweep, glow = -1, 0
    e = ease((s - 2.25) / 0.75) if 2 <= s < 3 else 1 - ease((s - 3) / 0.8) if s >= 3 else 0.0
    set_glow(sweep, glow)
    for o, dz, rz in LAYERS:
        z0, r0 = REST[o]; o.location.z = z0 + dz * e; o.rotation_euler.z = r0 + math.radians(rz) * e
    coin.rotation_euler = tuple(a + (b - a) * e for a, b in zip(ROT0, ROT1))
    coin.rotation_euler.z += spin

# idle loops: one full turn of the coin on its vertical axis, n frames, in the pose of a step
#   a = the plain coin (steps 01 and 02: 02 starts half a turn in), b = engraving lit (03), c = opened layers (04)
if "--loop" in argv:
    kind = arg("--loop"); fdir = arg("--out-dir"); n = int(arg("--n", "120"))
    os.makedirs(fdir, exist_ok=True)
    base_s = {"a": 0.0, "b": 2.0, "c": 3.0}[kind]
    for f in range(n):
        fp = os.path.join(fdir, f"f{f:03d}.png")
        if os.path.exists(fp) and "--force" not in argv: continue
        pose(base_s); coin.rotation_euler.z += 2 * math.pi * f / n
        sc.render.filepath = fp; bpy.ops.render.render(write_still=True)
        print(f"loop {kind} frame {f} done", flush=True)
    sys.exit(0)

if "--anim" in argv:
    fdir = arg("--anim"); n = int(arg("--n", "144")); a, b = [int(x) for x in arg("--range", f"0-{n - 1}").split("-")]
    os.makedirs(fdir, exist_ok=True)
    for f in range(a, b + 1):
        fp = os.path.join(fdir, f"f{f:03d}.png")
        if os.path.exists(fp) and "--force" not in argv: continue
        pose(4 * f / n); sc.render.filepath = fp; bpy.ops.render.render(write_still=True)
        print(f"frame {f} done", flush=True)
    sys.exit(0)

os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
if "--spin" in argv:
    n = int(arg("--spin")); fdir = arg("--frames", os.path.join(HERE, "renders/spin"))
    os.makedirs(fdir, exist_ok=True)
    for i in range(n):
        coin.rotation_euler = (math.radians(90), -2 * math.pi * i / n, 0)
        sc.render.filepath = os.path.join(fdir, f"f{i:04d}.png"); bpy.ops.render.render(write_still=True)
else:
    sc.render.filepath = OUT; bpy.ops.render.render(write_still=True)
    if STATE == "face" and "--save" in argv: bpy.ops.wm.save_as_mainfile(filepath=os.path.join(HERE, "prysm-hero.blend"))
print("done", OUT)
