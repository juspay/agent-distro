# The distribution without a distributor: upstream harnesses, no plugins, no
# gateway. It needs no npins directory because it pins nothing, which also
# makes it the smallest example of the profile shape.
{
  name = "vanilla";
  description = "Upstream harnesses with your own provider";
  plugins = [ ];
  gateway = null;
}
