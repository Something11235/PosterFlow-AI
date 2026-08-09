
# 导入网络请求库，用来发送API调用
import requests
import json
import base64
import os

# ===================== 服务配置（通过环境变量传入） =====================
api_key = os.getenv("IMAGE_API_KEY", "") or os.getenv("OPENROUTER_API_KEY", "")
api_endpoint = os.getenv("IMAGE_API_ENDPOINT", "https://openrouter.ai/api/v1/images")
image_model = os.getenv("IMAGE_API_MODEL", "openai/gpt-image-2")

# 绘画提示词
prompt = (
    "生成一张16:9横版公众号文章配图，国际商务科技风，主色为深海蓝、科技银灰和冷白高光。画面表现韩国AI产业硬核实力与成熟产业生态，视觉重点放在“科技巨头集群”和“AI基础设施”。构图采用城市天际线俯视构图：远处是首尔抽象城市轮廓与科技园区，前景以大型半导体芯片、智能终端、服务器矩阵、云计算图标组成半环形结构，周围有细密的AI神经网络线和数据流光点。画面气质理性、克制、高端，不夸张，不卡通。加入中文标题“全球科创硬核实力”，副标题“AI产业生态成熟”，现代无衬线字体，白色与浅蓝色搭配，标题位于左上区域，留出充足留白。"
)

# 【参考图设置】
enable_reference_image = False   # True启用参考图，False关闭
reference_image_path = r"D:\system\图片\AI\AI绘画程序\参考图\为什么选择新加坡.jpg"
# 图片保存目录
save_folder = r"D:\system\图片\AI\AI绘画程序\test"
# =========================================================

# 创建保存文件夹
os.makedirs(save_folder, exist_ok=True)

# 运行时输入图片名称
file_name_prefix = input("请输入图片保存名称：")

# 构造请求体
payload = {
    "model": image_model,
    "prompt": prompt
}

# 如果开启参考图，读取本地图片转为base64
if enable_reference_image:
    try:
        with open(reference_image_path, "rb") as img_file:
            img_base64 = base64.b64encode(img_file.read()).decode("utf-8")
        payload["image_b64"] = img_base64
        print(f"✅ 成功加载参考图：{reference_image_path}")
    except Exception as e:
        print(f"❌ 参考图读取失败：{e}")
        exit()


# 发起API请求
if not api_key:
    raise RuntimeError("请先设置 IMAGE_API_KEY 或 OPENROUTER_API_KEY 环境变量")

response = requests.post(
    url=api_endpoint,
    headers={
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    },
    data=json.dumps(payload)
)

# 打印返回原始信息（排错用，如果报错可以看到原因）
# print(response.text)

result = response.json()

# 判断接口是否返回错误
if "error" in result:
    print("❌ API返回错误：", result["error"])
else:
    for i, image in enumerate(result.get("data", [])):
        image_bytes = base64.b64decode(image["b64_json"])
        save_path = os.path.join(save_folder, f"{file_name_prefix}_{i+1}.png")
        with open(save_path, "wb") as f:
            f.write(image_bytes)
        print(f"✅ 图片已保存：{save_path}")
