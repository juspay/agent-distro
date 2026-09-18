{ my-skills }:
{
  name = "my-distribution";
  description = "My skills with your choice of coding agent";
  plugins = [ my-skills ];
  gateway = null;
  # To connect OMP to a LiteLLM gateway, replace null with:
  # {
  #   url = "https://llm.example.org";
  #   keyEnv = "LITELLM_API_KEY";
  #   models = { large = "large"; small = "fast"; };
  #   keyHint = "Get a key from your gateway administrator.";
  # };
}
