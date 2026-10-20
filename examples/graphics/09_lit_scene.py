"""A still scene showing materials and three kinds of light.

Nothing moves, so the program finishes right away; the picture stays in the
preview and you can still orbit and zoom it.
"""
import zinia_3d as scene

scene.create_scene()
scene.set_background("#0d1222")
scene.add_plane(width=14, height=14, color="#2a3352")

# A row of spheres from rough to shiny metal
for i in range(5):
    scene.add_sphere(x=-4 + i * 2, y=0.8, z=0, radius=0.8, color="#d9dde8",
                     metalness=i / 4, roughness=1 - i / 5)

scene.add_box(x=-3, y=0.75, z=-3.5, width=1.5, height=1.5, depth=1.5, color="#ff5c8a")
scene.add_cylinder(x=0, y=1, z=-3.5, radius_top=0.7, radius_bottom=0.7, height=2, color="#4cc9f0")
scene.add_box(x=3, y=0.75, z=-3.5, width=1.5, height=1.5, depth=1.5, color="#06d6a0", opacity=0.5)
scene.add_sphere(x=0, y=3.2, z=-3.5, radius=0.6, color="#ffd166", wireframe=True)

scene.add_light("ambient", intensity=0.25)
scene.add_light("directional", intensity=1.4, position=(-6, 10, 6))
scene.add_light("point", intensity=1.2, color="#ff9966", position=(4, 3, 3))

scene.set_camera(position=(0, 5, 10), target=(0, 0.8, -1), fov=50)
scene.show()
print("Scene ready:", len(scene.objects()), "objects and lights")
