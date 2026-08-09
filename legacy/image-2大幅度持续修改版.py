# 导入网络请求库，用来发送API调用
import requests
import json
import base64
import os

# ===================== 【服务配置：通过环境变量传入】 =====================
api_key = os.getenv("IMAGE_API_KEY", "") or os.getenv("OPENROUTER_API_KEY", "")
api_endpoint = os.getenv("IMAGE_API_ENDPOINT", "https://openrouter.ai/api/v1/images")
image_model = os.getenv("IMAGE_API_MODEL", "openai/gpt-image-2")

# 【初始参考图路径（第一轮可选加载）】
init_ref_path = r"D:\system\图片\AI\AI绘画程序\参考图\参考图.png"

# 图片保存目录
save_folder = r"D:\system\图片\AI\AI绘画程序\test"

# 迭代修改强度（0~1）越高越贴近原图，越低改动越大
img_strength = 0.65
# =================================================================

os.makedirs(save_folder, exist_ok=True)

# 全局变量：保存上一轮生成图片路径，用于迭代修改
last_generated_img = None

def image_to_base64(file_path):
    """本地图片转base64字符串"""
    try:
        with open(file_path, "rb") as f:
            return base64.b64encode(f.read()).decode("utf-8")
    except Exception as e:
        print(f"❌ 图片读取失败：{e}")
        return None


def generate_image(prompt, ref_img_path=None):
    """调用绘图接口，支持传入参考图迭代修改"""
    payload = {
        "model": image_model,
        "prompt": prompt,
        "strength": img_strength
    }

    # 如果传入参考图，开启图生图
    if ref_img_path and os.path.exists(ref_img_path):
        b64_data = image_to_base64(ref_img_path)
        if b64_data:
            payload["image_b64"] = b64_data
            print("✅ 启用参考图进行生成/修改")

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
    return response.json()


if __name__ == "__main__":
    print("===== AI海报迭代生成工具【独立Prompt版】 =====")
    print("使用规则：")
    print("1. 每一轮请输入【完整全套提示词】，不会自动继承上一轮文字")
    print("2. 第一轮可选加载本地参考图；后续自动使用上一轮生成图片")
    print("3. 输入 exit 退出程序\n")

    # 输入基础文件名
    file_prefix = input("请输入文件基础名称：")

    # 第一轮是否使用初始参考图选择
    use_init_ref = input("第一轮是否加载初始参考图？(y/n)：").strip().lower()
    first_ref_img = None
    if use_init_ref == "y":
        if os.path.exists(init_ref_path):
            first_ref_img = init_ref_path
            print(f"✅ 初始参考图已选定：{init_ref_path}")
        else:
            print(f"❌ 初始参考图不存在：{init_ref_path}，第一轮将不使用参考图")

    round_count = 1

    while True:
        print(f"\n---------- 第{round_count}轮绘图 ----------")
        # 等待用户输入本轮完整提示词
        current_prompt = input("请输入本轮完整Prompt(输入exit退出)：")
        if current_prompt.lower() == "exit":
            print("程序结束！")
            break

        # 第一轮使用初始参考图；之后使用上一轮生成图片
        if round_count == 1:
            ref_to_use = first_ref_img
        else:
            ref_to_use = last_generated_img

        # 调用接口
        res_data = generate_image(current_prompt, ref_to_use)

        # 检测报错
        if "error" in res_data:
            print("❌ API报错：", res_data["error"])
            continue

        # 保存图片
        for idx, img_info in enumerate(res_data.get("data", [])):
            img_bytes = base64.b64decode(img_info["b64_json"])
            save_name = f"{file_prefix}_轮{round_count}_{idx+1}.png"
            full_save_path = os.path.join(save_folder, save_name)

            with open(full_save_path, "wb") as f:
                f.write(img_bytes)
            print(f"✅ 已保存：{full_save_path}")
            # 记录最新生成图片，下一轮自动作为参考
            last_generated_img = full_save_path

        round_count += 1
