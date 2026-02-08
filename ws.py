import lark_oapi as lark
from lark_oapi.event.callback.model.p2_card_action_trigger import P2CardActionTrigger, P2CardActionTriggerResponse
from lark_oapi.event.callback.model.p2_url_preview_get import P2URLPreviewGet, P2URLPreviewGetResponse
from dotenv import load_dotenv
import os
# load environment variables from a local .env file
load_dotenv()

lark.APP_ID = os.getenv("FEISHU_APP_ID")
lark.APP_SECRET = os.getenv("FEISHU_APP_SECRET")

# 监听「卡片回传交互 card.action.trigger」
def do_card_action_trigger(data: P2CardActionTrigger) -> P2CardActionTriggerResponse:
    print(lark.JSON.marshal(data))
    resp = {
        "toast": {
            "type": "info",
            "content": "卡片回传成功 from python sdk"
        }
    }
    return P2CardActionTriggerResponse(resp)

# 监听「拉取链接预览数据 url.preview.get」
def do_url_preview_get(data: P2URLPreviewGet) -> P2URLPreviewGetResponse:
    print(lark.JSON.marshal(data))
    resp = {
        "inline": {
            "title": "链接预览测试",
        }
    }
    return P2URLPreviewGetResponse(resp)


# 监听「接收 IM 文本消息 im.message.receive_v1」并打印文本内容
from lark_oapi.api.im.v1.model.p2_im_message_receive_v1 import P2ImMessageReceiveV1

def do_im_message_receive(data: P2ImMessageReceiveV1) -> None:
    try:
        # 打印完整事件对象（序列化为 JSON）
        print("IM Event:", lark.JSON.marshal(data))

        # 尝试解析文本内容（Feishu 的 message.content 通常是 JSON 字符串，含 text 字段）
        content = None
        if getattr(data, 'event', None) and getattr(data.event, 'message', None):
            content = getattr(data.event.message, 'content', None)

        if content:
            try:
                import json
                parsed = json.loads(content)
                text = parsed.get('text') if isinstance(parsed, dict) else None
            except Exception:
                # content 有时直接是字符串
                text = content

            if text:
                print("Received text:", text)
            else:
                print("Received message, but no text field:", content)
        else:
            print("Received IM event with no content")
    except Exception as e:
        print("Error handling IM message event:", e)
event_handler = lark.EventDispatcherHandler.builder("", "") \
    .register_p2_card_action_trigger(do_card_action_trigger) \
    .register_p2_url_preview_get(do_url_preview_get) \
    .register_p2_im_message_receive_v1(do_im_message_receive) \
    .build()
def main():
    cli = lark.ws.Client(lark.APP_ID, lark.APP_SECRET,
                         event_handler=event_handler, log_level=lark.LogLevel.DEBUG)
    cli.start()
if __name__ == "__main__":
    main()

